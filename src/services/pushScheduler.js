import { query } from '../db/pool.js'
import { sendPush } from './pushService.js'

const RESOURCE_CHECK_MS = 5 * 60 * 1000
const BIRTHDAY_CHECK_MS = 30 * 60 * 1000
const QUIET_MINUTES = 10 // wait this long after the latest approval so one batch = one push
const BIRTHDAY_FROM_HOUR = 7 // Lagos time
const BIRTHDAY_TTL = 12 * 60 * 60 // a birthday wish is useless a day later
const RESOURCE_TTL = 24 * 60 * 60

function lagosNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())
  const get = (type) => Number(parts.find((p) => p.type === type).value)
  const y = get('year')
  const m = get('month')
  const d = get('day')
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return { y, m, d, hour: get('hour'), includeFeb29: m === 2 && d === 28 && !leap }
}

async function announceNewResources() {
  const pending = await query(
    `SELECT id, title, COALESCE(reviewed_at, created_at) AS ready_at
     FROM resources
     WHERE status = 'approved' AND push_announced = false
     ORDER BY COALESCE(reviewed_at, created_at) ASC
     LIMIT 50`
  )
  if (pending.rows.length === 0) return

  const newest = Math.max(...pending.rows.map((r) => new Date(r.ready_at).getTime()))
  if (Date.now() - newest < QUIET_MINUTES * 60 * 1000) return

  // Claim first so a second run can never send the same ones twice.
  const claimed = await query(
    `UPDATE resources SET push_announced = true
     WHERE id = ANY($1) AND push_announced = false
     RETURNING id, title`,
    [pending.rows.map((r) => r.id)]
  )
  if (claimed.rows.length === 0) return

  const n = claimed.rows.length
  const titles = claimed.rows.map((r) => r.title)
  await sendPush({
    category: 'resources',
    title: n === 1 ? 'New in the library' : `${n} new resources added`,
    body: n === 1 ? titles[0] : titles.slice(0, 3).join(', ') + (n > 3 ? ` and ${n - 3} more` : ''),
    url: n === 1 ? `/library/${claimed.rows[0].id}` : '/shelf?sort=recent',
    tag: 'new-resources',
    image:
      n === 1 && process.env.PUBLIC_API_BASE_URL
        ? `${process.env.PUBLIC_API_BASE_URL.replace(/\/$/, '')}/api/resources/${claimed.rows[0].id}/thumbnail`
        : null,
    ttl: RESOURCE_TTL,
  })
}

async function sendBirthdayPushes() {
  const { y, m, d, hour, includeFeb29 } = lagosNow()
  if (hour < BIRTHDAY_FROM_HOUR) return

  const due = await query(
    `SELECT u.id, u.name FROM users u
     WHERE u.is_suspended = false
       AND ((u.birth_month = $1 AND u.birth_day = $2) OR ($3::boolean AND u.birth_month = 2 AND u.birth_day = 29))
       AND u.birthday_pushed_year IS DISTINCT FROM $4::smallint
       AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id)
     LIMIT 200`,
    [m, d, includeFeb29, y]
  )

  for (const u of due.rows) {
    await query('UPDATE users SET birthday_pushed_year = $1 WHERE id = $2', [y, u.id])
    const first = String(u.name || '').trim().split(/\s+/)[0] || 'friend'
    await sendPush({
      category: 'birthday',
      userIds: [u.id],
      title: `Happy Birthday, ${first}! 🎂`,
      body: 'Everyone at RCF MOUAU Library is celebrating you today. God bless your new year of life.',
      url: '/home',
      tag: 'birthday',
      ttl: BIRTHDAY_TTL,
    })
  }
}

let started = false

export function startPushLoops() {
  if (started) return
  started = true
  const run = (fn, label) => () => fn().catch((err) => console.error(`${label} failed:`, err.message))

  setTimeout(run(announceNewResources, 'New resource push'), 2 * 60 * 1000).unref?.()
  setInterval(run(announceNewResources, 'New resource push'), RESOURCE_CHECK_MS).unref?.()
  setTimeout(run(sendBirthdayPushes, 'Birthday push'), 90 * 1000).unref?.()
  setInterval(run(sendBirthdayPushes, 'Birthday push'), BIRTHDAY_CHECK_MS).unref?.()
}
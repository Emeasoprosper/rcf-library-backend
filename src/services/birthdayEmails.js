// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/birthdayEmails.js
import { query } from '../db/pool.js'
import { sendMail, mailerConfigured } from './mailer.js'

const SEND_FROM_HOUR = 7 // Lagos time, 24h clock
const CHECK_EVERY_MS = 60 * 60 * 1000
const MAX_PER_RUN = 40
const MAX_ATTEMPTS = 3
const APP_URL = (process.env.FRONTEND_URLS || '').split(',')[0]?.trim() || 'https://rcf-mouau-library.vercel.app'

const attempts = new Map() // user id -> failed tries today

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

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

function buildEmail(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'friend'
  const safe = esc(first)
  const html = `<!doctype html>
<html><body style="margin:0;background:#0f0f10;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f10;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:20px;overflow:hidden;">
<tr><td style="background:#ec4899;background:linear-gradient(135deg,#f97316,#ec4899,#8b5cf6);padding:36px 24px;text-align:center;color:#ffffff;">
<div style="font-size:48px;line-height:1;">🎂</div>
<h1 style="margin:12px 0 0;font-size:26px;">Happy Birthday, ${safe}!</h1>
</td></tr>
<tr><td style="padding:24px;color:#222222;font-size:16px;line-height:1.6;">
<p style="margin:0 0 16px;">Today is your day, and everyone at RCF MOUAU Library is celebrating you. We thank God for your life and pray that this new year of life brings you grace, wisdom and joy.</p>
<p style="text-align:center;margin:28px 0;"><a href="${APP_URL}" style="background:#f97316;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:bold;display:inline-block;">Open the library</a></p>
<p style="margin:0;font-size:13px;color:#777777;">You are getting this because you added your birthday to your RCF MOUAU Library profile. You can change or remove it any time under Profile, then Birthday &amp; contact.</p>
</td></tr>
</table></td></tr></table></body></html>`
  const text = `Happy Birthday, ${first}!\n\nToday is your day, and everyone at RCF MOUAU Library is celebrating you. We thank God for your life and pray that this new year of life brings you grace, wisdom and joy.\n\nOpen the library: ${APP_URL}\n\nYou are getting this because you added your birthday to your profile. You can change or remove it under Profile, then Birthday & contact.`
  return { subject: `Happy Birthday, ${first}! 🎉`, html, text }
}

async function runOnce() {
  const { y, m, d, hour, includeFeb29 } = lagosNow()
  if (hour < SEND_FROM_HOUR) return
  if (attempts.size > 1000) attempts.clear()

  const due = await query(
    `SELECT id, name, email FROM users
     WHERE is_suspended = false AND email IS NOT NULL
       AND ((birth_month = $1 AND birth_day = $2) OR ($3::boolean AND birth_month = 2 AND birth_day = 29))
       AND birthday_emailed_year IS DISTINCT FROM $4::smallint
     ORDER BY id
     LIMIT $5`,
    [m, d, includeFeb29, y, MAX_PER_RUN]
  )

  for (const u of due.rows) {
    try {
      const mail = buildEmail(u.name)
      await sendMail({ to: u.email, toName: u.name, ...mail })
      await query('UPDATE users SET birthday_emailed_year = $1 WHERE id = $2', [y, u.id])
      attempts.delete(u.id)
    } catch (err) {
      console.error(`Birthday email failed for user ${u.id}:`, err.message)
      const tries = (attempts.get(u.id) || 0) + 1
      attempts.set(u.id, tries)
      // After a few failures stop retrying this year, so one bad address never blocks the rest.
      if (tries >= MAX_ATTEMPTS) {
        await query('UPDATE users SET birthday_emailed_year = $1 WHERE id = $2', [y, u.id]).catch(() => {})
      }
    }
  }
}

export function startBirthdayEmailLoop() {
  if (!mailerConfigured()) {
    console.log('Birthday emails are off. Set BREVO_API_KEY and MAIL_FROM_EMAIL to turn them on.')
    return
  }
  const tick = () => runOnce().catch((err) => console.error('Birthday email run failed:', err.message))
  setTimeout(tick, 60 * 1000).unref?.()
  setInterval(tick, CHECK_EVERY_MS).unref?.()
}
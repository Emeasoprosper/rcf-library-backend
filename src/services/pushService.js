import webpush from 'web-push'
import { query } from '../db/pool.js'

webpush.setVapidDetails(
  'mailto:support@rcf-mouau-library.vercel.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
)

const CHUNK = 100

// category: 'news' | 'announcements' | 'resources' | 'birthday' | 'updates'
// userIds: omit to send to everyone who opted in to that category.
// ttl: seconds the push service holds the message for a phone that is
// offline, after that it is dropped.
export async function sendPush({ category, userIds = null, title, body, url, tag, image = null, ttl = 86400 }) {
  const params = [category]
  let userFilter = ''
  if (userIds) {
    if (userIds.length === 0) return 0
    params.push(userIds)
    userFilter = 'AND ps.user_id = ANY($2)'
  }

  const subs = await query(
    `SELECT ps.endpoint, ps.p256dh, ps.auth
     FROM push_subscriptions ps
     JOIN users u ON u.id = ps.user_id
     WHERE u.is_suspended = false
       AND COALESCE((u.push_prefs ->> $1::text)::boolean, true) = true
       ${userFilter}`,
    params
  )

  const payload = JSON.stringify({ title, body, url, tag, image })
  let sent = 0

  for (let i = 0; i < subs.rows.length; i += CHUNK) {
    const chunk = subs.rows.slice(i, i + CHUNK)
    await Promise.all(
      chunk.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: ttl, urgency: 'normal' }
          )
          sent += 1
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]).catch(() => {})
          } else {
            console.error('Push send failed:', err.statusCode, err.body || err.message)
          }
        }
      })
    )
  }
  return sent
}
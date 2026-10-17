// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/birthdays.js
import { Router } from 'express'
import { query } from '../db/pool.js'
import { attachUser, requireAuth } from '../middleware/auth.js'

const router = Router()

// Today's date in Lagos, not the server's own timezone.
function lagosToday() {
  const [y, m, d] = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }).split('-').map(Number)
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  // Feb 29 birthdays are celebrated on Feb 28 in years that have no Feb 29.
  return { m, d, includeFeb29: m === 2 && d === 28 && !leap }
}

// GET /api/birthdays/today — signed-in users only. A phone or WhatsApp
// number is only ever returned for someone who ticked "show my contact".
router.get('/today', attachUser, requireAuth, async (req, res) => {
  const { m, d, includeFeb29 } = lagosToday()
  const result = await query(
    `SELECT id, name, avatar_url, contact_public, phone_number, whatsapp_number,
            COUNT(*) OVER()::int AS total
     FROM users
     WHERE is_suspended = false AND birthday_public = true AND show_profile = true
       AND ((birth_month = $1 AND birth_day = $2)
            OR ($3::boolean AND birth_month = 2 AND birth_day = 29))
     ORDER BY name ASC
     LIMIT 12`,
    [m, d, includeFeb29]
  )

  const items = result.rows.map((u) => ({
    id: u.id,
    name: u.name,
    avatarUrl: u.avatar_url,
    isYou: u.id === req.user.id,
    phone: u.contact_public ? u.phone_number || null : null,
    whatsapp: u.contact_public ? u.whatsapp_number || null : null,
  }))
  items.sort((a, b) => Number(b.isYou) - Number(a.isYou)) // your own card first

  res.setHeader('Cache-Control', 'private, max-age=300')
  res.json({ total: result.rows[0]?.total || 0, items })
})

export default router
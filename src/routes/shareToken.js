// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/shareToken.js
import { Router } from 'express'
import { query } from '../db/pool.js'

const router = Router()
const APP_URL = (process.env.FRONTEND_URLS || '').split(',')[0]?.trim() || 'https://rcf-mouau-library.vercel.app'

// GET /s/:token — a specific share link (see POST /:id/share in
// resources.js). Redirects straight to the permanent /library/:id page,
// which does the actual rendering — one canonical page per resource
// instead of duplicate content living at two URLs (token pages are
// one-per-resource too via the UNIQUE constraint, but this keeps
// Google's indexed URL always pointing at the stable /library/:id one).
router.get('/:token', async (req, res) => {
  const result = await query(
    `SELECT rs.resource_id FROM resource_shares rs
     JOIN resources r ON r.id = rs.resource_id
     WHERE rs.token = $1 AND r.status = 'approved'`,
    [req.params.token]
  )
  if (result.rows.length === 0) {
    return res.status(404).send('<h1>This link is no longer available.</h1>')
  }
  await query(`UPDATE resource_shares SET click_count = click_count + 1 WHERE token = $1`, [req.params.token])

  const backendOrigin = `${req.protocol}://${req.get('host')}`
  res.redirect(302, `${backendOrigin}/library/${result.rows[0].resource_id}`)
})

export default router
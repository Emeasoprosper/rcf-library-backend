// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/shareLanding.js
import { Router } from 'express'
import { query } from '../db/pool.js'

const router = Router()
const SITE_NAME = 'RCFMOUAU Library'
const APP_URL = (process.env.FRONTEND_URLS || '').split(',')[0]?.trim() || 'https://rcf-mouau-library.vercel.app'

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// GET /s/:token — public, no auth, no cookies. Serves OG meta tags for
// link-unfurling crawlers (WhatsApp, Telegram, iMessage, Facebook,
// Twitter/X, Discord, Slack all read the same tags from this same
// response) and, for a real visitor, immediately redirects into the
// frontend app. Deliberately contains NO reference to any download or
// stream endpoint — only the resource's public thumbnail image and a
// redirect URL. The actual file is only ever reachable via the
// frontend's authenticated /resources/:id flow.
router.get('/:token', async (req, res) => {
  const result = await query(
    `SELECT rs.resource_id, r.title, r.author, r.description, r.status
     FROM resource_shares rs
     JOIN resources r ON r.id = rs.resource_id
     WHERE rs.token = $1`,
    [req.params.token]
  )

  if (result.rows.length === 0 || result.rows[0].status !== 'approved') {
    res.status(404).send('<h1>This link is no longer available.</h1>')
    return
  }

  const { resource_id, title, author, description } = result.rows[0]
  const backendOrigin = `${req.protocol}://${req.get('host')}`
  const thumbnailUrl = `${backendOrigin}/api/resources/${resource_id}/thumbnail`
  const redirectUrl = `${APP_URL}/s/${req.params.token}`

  const safeTitle = escapeHtml(title)
  const safeDesc = escapeHtml(author ? `By ${author}` : (description || `Shared from ${SITE_NAME}`))

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeTitle} — ${SITE_NAME}</title>
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:image" content="${thumbnailUrl}">
  <meta property="og:url" content="${backendOrigin}/s/${req.params.token}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${thumbnailUrl}">
  <meta http-equiv="refresh" content="0; url=${redirectUrl}">
  <script>window.location.replace(${JSON.stringify(redirectUrl)});</script>
</head>
<body>
  <p>Redirecting to ${safeTitle} on ${SITE_NAME}… <a href="${redirectUrl}">Tap here if you're not redirected.</a></p>
</body>
</html>`)
})

export default router
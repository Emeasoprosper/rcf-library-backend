// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/shareLanding.js
import { Router } from 'express'
import { query } from '../db/pool.js'
import { getThumbnailMeta } from './resources.js'

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
    `SELECT rs.resource_id, r.title, r.author, r.description, r.status, r.thumbnail_file_id
     FROM resource_shares rs
     JOIN resources r ON r.id = rs.resource_id
     WHERE rs.token = $1`,
    [req.params.token]
  )

  if (result.rows.length === 0 || result.rows[0].status !== 'approved') {
    res.status(404).send('<h1>This link is no longer available.</h1>')
    return
  }

  const { resource_id, title, author, description, thumbnail_file_id } = result.rows[0]
  const backendOrigin = `${req.protocol}://${req.get('host')}`
  const thumbnailUrl = `${backendOrigin}/api/resources/${resource_id}/thumbnail`
  const redirectUrl = `${APP_URL}/s/${req.params.token}`

  const safeTitle = escapeHtml(title)
  const safeDesc = escapeHtml(author ? `By ${author}` : (description || `Shared from ${SITE_NAME}`))

  // Best-effort, TIME-BOXED. This page's own load must stay fast
  // regardless of thumbnail state — confirmed via live testing that
  // letting this block on an uncached thumbnail (full Drive fetch +
  // sharp resize) slowed the page response enough to break WhatsApp's
  // preview entirely, worse than omitting these tags. If the thumbnail
  // is already cached this resolves near-instantly; if not, it's
  // skipped this time and will simply be present on the NEXT request
  // once the normal /thumbnail route (hit separately by the crawler)
  // has warmed the cache.
  let imageWidth = null
  let imageHeight = null
  if (thumbnail_file_id) {
    try {
      const meta = await Promise.race([
        getThumbnailMeta(thumbnail_file_id),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 800)),
      ])
      imageWidth = meta.width
      imageHeight = meta.height
    } catch (err) {
      // Timed out or failed — not an error worth logging noisily, this
      // is an expected/acceptable skip path, not a bug.
    }
  }
  const dimensionTags = imageWidth && imageHeight
    ? `\n  <meta property="og:image:width" content="${imageWidth}">\n  <meta property="og:image:height" content="${imageHeight}">`
    : ''

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
  <meta property="og:image" content="${thumbnailUrl}">${dimensionTags}
  <meta property="og:url" content="${backendOrigin}/s/${req.params.token}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${thumbnailUrl}">
  <!-- No meta http-equiv="refresh" here on purpose. Facebook/WhatsApp's
       crawler (unlike a real browser) doesn't execute JS but DOES follow
       a meta-refresh — so it was following this straight to the frontend
       route below and hitting a 404 there, wiping out every og: tag on
       this page before Facebook ever saw them. Real visitors still get
       redirected instantly via the script below; a meta-refresh fallback
       just isn't worth breaking link previews for. -->
  <script>window.location.replace(${JSON.stringify(redirectUrl)});</script>
</head>
<body>
  <p>Redirecting to ${safeTitle} on ${SITE_NAME}… <a href="${redirectUrl}">Tap here if you're not redirected.</a></p>
</body>
</html>`)
})

export default router
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

// Shared by both /library/:id (permanent, exists for every resource —
// this is what makes individual books discoverable via a plain Google
// search) and /s/:token (a specific share link). Renders real content
// directly in the HTML with NO forced JS redirect — Google's crawler
// sometimes executes JS and follows client-side redirects when ranking
// a page, and redirecting straight into an app shell reads as a weaker
// signal than a page with genuine standalone content. A real visitor
// just sees a normal page with a button, not a blind auto-bounce.
async function renderSeoPage(req, res, { resourceRow, canonicalUrl, ctaUrl }) {
  const { id, title, author, description, thumbnail_file_id, category, department, level } = resourceRow
  const backendOrigin = `${req.protocol}://${req.get('host')}`
  const shareImageUrl = `${backendOrigin}/api/resources/${id}/thumbnail`

  const safeTitle = escapeHtml(title)
  const safeDesc = escapeHtml(author ? `By ${author}` : (description || `Shared from ${SITE_NAME}`))
  const safeDescLong = escapeHtml(description || safeDesc)

  let dimensionTags = ''
  if (thumbnail_file_id) {
    try {
      const meta = await Promise.race([
        getThumbnailMeta(thumbnail_file_id),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 800)),
      ])
      if (meta.width && meta.height) {
        dimensionTags = `\n  <meta property="og:image:width" content="${meta.width}">\n  <meta property="og:image:height" content="${meta.height}">`
      }
    } catch {
      // Best-effort — omitted if not ready in time, same as before.
    }
  }

  // schema.org structured data — this is what lets Google show a richer
  // result (title, author, image) for a specific book search rather than
  // a plain blue link, similar to how LearnOutLoud's page rendered.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: title,
    ...(author ? { author: { '@type': 'Person', name: author } } : {}),
    ...(description ? { description } : {}),
    image: shareImageUrl,
    url: canonicalUrl,
    ...(category ? { genre: category } : {}),
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeTitle} — ${SITE_NAME}</title>
  <link rel="canonical" href="${canonicalUrl}">
  <meta name="description" content="${safeDescLong}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:image" content="${shareImageUrl}">${dimensionTags}
  <meta property="og:url" content="${canonicalUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${shareImageUrl}">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 20px; color: #eee; background: #0a0a0a; }
    img { width: 100%; border-radius: 8px; margin-bottom: 16px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    p.meta { color: #999; margin: 0 0 16px; }
    p.desc { color: #ccc; line-height: 1.5; }
    a.cta { display: inline-block; margin-top: 20px; padding: 12px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 24px; font-weight: 600; }
  </style>
</head>
<body>
  <img src="${shareImageUrl}" alt="${safeTitle}">
  <h1>${safeTitle}</h1>
  <p class="meta">${safeDesc}${department ? ` · ${escapeHtml(department)}` : ''}${level ? ` · ${escapeHtml(level)} Level` : ''}</p>
  ${description ? `<p class="desc">${safeDescLong}</p>` : ''}
  <a class="cta" href="${ctaUrl}">Open in ${SITE_NAME}</a>
</body>
</html>`)
}

// GET /library/:id — PERMANENT public page for every approved resource,
// regardless of whether anyone has ever generated a share link for it.
// This is the page that actually makes individual books findable via a
// plain Google search — see sitemap.xml below, which lists one of these
// per resource so Google discovers all of them, not just shared ones.
router.get('/:id', async (req, res) => {
  const result = await query(
    `SELECT id, title, author, description, status, thumbnail_file_id, category_id, department_id, level,
            (SELECT name FROM categories WHERE id = category_id) AS category,
            (SELECT name FROM departments WHERE id = department_id) AS department
     FROM resources WHERE id = $1`,
    [req.params.id]
  )
  if (result.rows.length === 0 || result.rows[0].status !== 'approved') {
    return res.status(404).send('<h1>Resource not found.</h1>')
  }
  const backendOrigin = `${req.protocol}://${req.get('host')}`
  await renderSeoPage(req, res, {
    resourceRow: result.rows[0],
    canonicalUrl: `${backendOrigin}/library/${req.params.id}`,
    ctaUrl: `${APP_URL}/resources/${req.params.id}`,
  })
})

export default router
// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/collectionLanding.js
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

// GET /collections/:id — public SEO page for a collection (folder).
// Lists the approved resources inside it so Google can see what's in
// the folder. Files themselves stay behind sign-in.
router.get('/:id', async (req, res) => {
  const collectionResult = await query(
    `SELECT id, title, author, description, cover_file_id FROM resource_collections WHERE id = $1`,
    [req.params.id]
  )
  if (collectionResult.rows.length === 0) {
    return res.status(404).send('<h1>Collection not found.</h1>')
  }
  const collection = collectionResult.rows[0]

  const resourcesResult = await query(
    `SELECT id, title, thumbnail_file_id FROM resources
     WHERE collection_id = $1 AND status = 'approved'
     ORDER BY collection_sort_order ASC, created_at ASC
     LIMIT 200`,
    [req.params.id]
  )
  const resources = resourcesResult.rows
  if (resources.length === 0) {
    return res.status(404).send('<h1>Collection not found.</h1>')
  }

  const backendOrigin = `${req.protocol}://${req.get('host')}`
  const canonicalUrl = `${APP_URL}/collections/${collection.id}`

  let imageUrl = null
  if (collection.cover_file_id) {
    imageUrl = `${backendOrigin}/api/resource-collections/${collection.id}/cover`
  } else {
    const withThumb = resources.find((r) => r.thumbnail_file_id)
    if (withThumb) imageUrl = `${backendOrigin}/api/resources/${withThumb.id}/thumbnail`
  }

  const count = resources.length
  const topTitles = resources.slice(0, 5).map((r) => r.title).join(', ')
  const baseDesc =
    collection.description ||
    `${count} study material${count !== 1 ? 's' : ''} in ${collection.title}${collection.author ? ` by ${collection.author}` : ''} on ${SITE_NAME}.`
  const fullDesc = `${baseDesc} Includes: ${topTitles}`.slice(0, 300)

  const safeTitle = escapeHtml(collection.title)
  const safeDesc = escapeHtml(fullDesc)

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: collection.title,
    description: fullDesc,
    url: canonicalUrl,
    ...(collection.author ? { author: { '@type': 'Person', name: collection.author } } : {}),
    ...(imageUrl ? { image: imageUrl } : {}),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: count,
      itemListElement: resources.slice(0, 100).map((r, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${APP_URL}/library/${r.id}`,
        name: r.title,
      })),
    },
  }
  const jsonLdSafe = JSON.stringify(jsonLd).replace(/</g, '\\u003c')

  const imageTags = imageUrl
    ? `\n  <meta property="og:image" content="${imageUrl}">\n  <meta name="twitter:image" content="${imageUrl}">`
    : ''

  const listHtml = resources
    .map((r) => `<li><a href="${APP_URL}/library/${r.id}">${escapeHtml(r.title)}</a></li>`)
    .join('\n    ')

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeTitle} — ${SITE_NAME}</title>
  <link rel="canonical" href="${canonicalUrl}">
  <meta name="description" content="${safeDesc}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:url" content="${canonicalUrl}">${imageTags}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <script type="application/ld+json">${jsonLdSafe}</script>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p>${safeDesc}</p>
  <ul>
    ${listHtml}
  </ul>
  <a href="${canonicalUrl}">Open in ${SITE_NAME}</a>
</body>
</html>`)
})

export default router
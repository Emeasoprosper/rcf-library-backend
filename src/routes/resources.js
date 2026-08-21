import { Router } from 'express'
import crypto from 'crypto'
import sharp from 'sharp'
import { query } from '../db/pool.js'
import { attachUser, requireAuth } from '../middleware/auth.js'
import { downloadFromStorage, convertOfficeFileToPdf } from '../services/storage.js'
import { watermarkPdf } from '../services/watermark.js'

const router = Router()

// .docx is excluded on purpose — docx-preview already renders it
// client-side from the raw bytes, so converting it here would just add
// a slower Drive round-trip for no benefit. These three have no working
// client-side renderer, so they're converted to a real PDF on every
// stream/download request instead.
const OFFICE_TO_PDF_MIME_TYPES = new Set([
  'application/msword',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

function buildPrefixTsQuery(raw) {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[&|!():*']/g, ''))
    .filter(Boolean)
  if (tokens.length === 0) return null
  return tokens.map((t) => `${t}:*`).join(' & ')
}

// attachUser (optional auth — doesn't reject anonymous requests, just
// populates req.user when a valid session exists) so a logged-in user's
// bookmark state can be reported per-item. Anonymous browsing still
// works exactly as before.
router.get('/', attachUser, async (req, res) => {
  const {
    search = '',
    type,
    category,
    department,
    level,
    semester,
    page = 1,
    pageSize = 20,
    sort = 'recent',
  } = req.query

  const conditions = [`r.status = 'approved'`]
  // `params` holds ONLY the filter params that actually appear in
  // whereClause — shared verbatim between the rows query and the count
  // query below, so every $n in whereClause must correspond to something
  // pushed here. The user id for the is_bookmarked check is NOT put in
  // here (that was the bug last time — an unused param slot broke the
  // count query when zero filters were active). It's appended separately
  // below, only for the rows query, with its own placeholder index.
  const params = []

  let rankExpr = null

  if (search.trim()) {
    const raw = search.trim()
    params.push(raw)
    const rawIdx = params.length

    const prefixQuery = buildPrefixTsQuery(raw)
    const orClauses = []

    if (prefixQuery) {
      params.push(prefixQuery)
      const prefixIdx = params.length
      orClauses.push(`r.search_vector @@ to_tsquery('english', $${prefixIdx})`)
      rankExpr = `GREATEST(ts_rank(r.search_vector, to_tsquery('english', $${prefixIdx})), similarity(r.title, $${rawIdx}))`
    } else {
      rankExpr = `similarity(r.title, $${rawIdx})`
    }

    orClauses.push(`r.title % $${rawIdx}`)
    orClauses.push(`r.title ILIKE '%' || $${rawIdx} || '%'`)
    orClauses.push(`r.author ILIKE '%' || $${rawIdx} || '%'`)

    conditions.push(`(${orClauses.join(' OR ')})`)
  }
  if (type) {
    const types = type.split(',').map((t) => t.trim()).filter(Boolean)
    params.push(types)
    conditions.push(`rt.slug = ANY($${params.length})`)
  }
  if (category) {
    params.push(category)
    conditions.push(`c.name = $${params.length}`)
  }
  if (department) {
    params.push(department)
    conditions.push(`d.name = $${params.length}`)
  }
  if (level) {
    params.push(level)
    conditions.push(`r.level = $${params.length}`)
  }
  if (semester) {
    params.push(semester)
    conditions.push(`r.semester = $${params.length}`)
  }

  const orderBy = rankExpr
    ? `${rankExpr} DESC, r.created_at DESC`
    : {
        recent: 'r.created_at DESC',
        popular: 'r.download_count DESC',
        title: 'r.title ASC',
      }[sort] || 'r.created_at DESC'

  const limit = Math.min(Number(pageSize) || 20, 50)
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit
  const whereClause = conditions.join(' AND ')

  const userIdIdx = params.length + 1
  const limitIdx = params.length + 2
  const offsetIdx = params.length + 3

  const rows = await query(
    `SELECT r.id, r.title, r.author, r.description, r.course_code, r.level, r.semester,
            r.thumbnail_url, r.thumbnail_status, r.file_type, r.file_size_bytes,
            r.page_count, r.duration_seconds, r.download_count, r.view_count, r.created_at,
            r.media_subtype,
            rt.slug AS type, rt.label AS type_label, rt.icon AS type_icon,
            c.name AS category, d.name AS department,
            EXISTS (SELECT 1 FROM bookmarks bk WHERE bk.user_id = $${userIdIdx} AND bk.resource_id = r.id) AS is_bookmarked
     FROM resources r
     JOIN resource_types rt ON rt.id = r.resource_type_id
     LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN departments d ON d.id = r.department_id
     WHERE ${whereClause}
     ORDER BY ${orderBy}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...params, req.user?.id || null, limit, offset]
  )

  // count query never gets the user id — it has no is_bookmarked
  // subquery, so it must only receive params that whereClause references.
  const count = await query(
    `SELECT COUNT(*) FROM resources r
     JOIN resource_types rt ON rt.id = r.resource_type_id
     LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN departments d ON d.id = r.department_id
     WHERE ${whereClause}`,
    params
  )

  res.json({
    items: rows.rows,
    total: Number(count.rows[0].count),
    page: Number(page),
    pageSize: limit,
  })
})

router.get('/meta/categories', async (req, res) => {
  const result = await query(
    `SELECT c.id, c.name, COUNT(r.id)::int AS count
     FROM categories c
     JOIN resources r ON r.category_id = c.id AND r.status = 'approved'
     GROUP BY c.id, c.name
     ORDER BY count DESC, c.name ASC`
  )
  res.json({ items: result.rows })
})

// GET /meta/all-categories — every category, unfiltered by resource
// count (unlike /meta/categories above, which only returns categories
// that already have approved resources — right for filter chips, wrong
// for a "suggest new material" form where the category might not have
// any resources yet).
router.get('/meta/all-categories', async (req, res) => {
  const result = await query(`SELECT id, name FROM categories ORDER BY name ASC`)
  res.json({ items: result.rows })
})

// POST /meta/categories  { name }
// Lets any signed-in user add a brand new category on the fly — e.g.
// while uploading, if none of the existing ones fit. Case-insensitive
// dedupe: if "theology" and "Theology" both get typed by different
// people, this returns the SAME existing row instead of creating a
// duplicate that would silently split resources across two categories
// that look identical to a user.
router.post('/meta/categories', attachUser, requireAuth, async (req, res) => {
  const { name } = req.body
  const trimmed = (name || '').trim()
  if (!trimmed) return res.status(400).json({ error: 'Category name is required' })
  if (trimmed.length > 60) return res.status(400).json({ error: 'Category name is too long' })

  const existing = await query(`SELECT id, name FROM categories WHERE name ILIKE $1`, [trimmed])
  if (existing.rows.length > 0) {
    return res.status(200).json({ id: existing.rows[0].id, name: existing.rows[0].name, created: false })
  }

  const inserted = await query(`INSERT INTO categories (name) VALUES ($1) RETURNING id, name`, [trimmed])
  res.status(201).json({ id: inserted.rows[0].id, name: inserted.rows[0].name, created: true })
})

// GET /meta/departments — full department list for form dropdowns.
router.get('/meta/departments', async (req, res) => {
  const result = await query(`SELECT id, name FROM departments ORDER BY name ASC`)
  res.json({ items: result.rows })
})

// POST /:id/share — creates (or returns the existing) share link for a
// resource. One canonical token per resource (UNIQUE constraint on
// resource_id), so re-sharing the same file always produces the same
// link instead of littering the table with duplicates. Requires auth —
// only a signed-in user can mint a link, though anyone who receives it
// still has to sign in themselves to actually open the preview (see
// /share/:token/resolve below and shareLanding.js for the public
// unfurl page crawlers read).
router.post('/:id/share', attachUser, requireAuth, async (req, res) => {
  const resourceCheck = await query(
    `SELECT id FROM resources WHERE id = $1 AND status = 'approved'`,
    [req.params.id]
  )
  if (resourceCheck.rows.length === 0) return res.status(404).json({ error: 'Resource not found' })

  const existing = await query(`SELECT token FROM resource_shares WHERE resource_id = $1`, [req.params.id])
  let token = existing.rows[0]?.token

  if (!token) {
    token = crypto.randomBytes(9).toString('base64url') // ~12 url-safe chars
    await query(
      `INSERT INTO resource_shares (resource_id, token, created_by)
       VALUES ($1, $2, $3) ON CONFLICT (resource_id) DO NOTHING`,
      [req.params.id, token, req.user.id]
    )
    // Re-read in case a concurrent request won the race and inserted first.
    const confirmed = await query(`SELECT token FROM resource_shares WHERE resource_id = $1`, [req.params.id])
    token = confirmed.rows[0].token
  }

  const shareBaseUrl = process.env.SHARE_BASE_URL || `${req.protocol}://${req.get('host')}`
  res.json({ token, shareUrl: `${shareBaseUrl}/s/${token}` })
})

// GET /share/:token/resolve — the ONLY thing a share token can be
// exchanged for is a resource id. Requires auth, same as every other
// resource-scoped route — so opening a shared link with no account (or
// an expired session) stops here and the frontend sends the visitor to
// sign in first. There is deliberately no equivalent "resolve to a
// download" route: getting the file still means going through the
// normal /resources/:id page and its existing, unchanged download gate.
router.get('/share/:token/resolve', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `SELECT rs.resource_id, r.status FROM resource_shares rs
     JOIN resources r ON r.id = rs.resource_id
     WHERE rs.token = $1`,
    [req.params.token]
  )
  if (result.rows.length === 0 || result.rows[0].status !== 'approved') {
    return res.status(404).json({ error: 'Share link not found or no longer available' })
  }
  await query(`UPDATE resource_shares SET click_count = click_count + 1 WHERE token = $1`, [req.params.token])
  res.json({ resourceId: result.rows[0].resource_id })
})

// Sniffs the real image format from the file's magic bytes instead of
// assuming PNG. Serving the wrong Content-Type here (e.g. labeling a
// real JPEG as image/png) is a common reason Meta's link-preview
// crawler — which WhatsApp, Facebook, and Instagram all share —
// silently rejects the image and falls back to the small text-only
// link card instead of the big Spotify-style preview.
function sniffImageContentType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  ) {
    return 'image/png'
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    return 'image/webp'
  }
  return 'image/jpeg' // safest fallback — matches most cover-generation output
}

// In-process thumbnail cache. This is what actually fixes the WhatsApp/
// crawler preview: without it, EVERY request for a thumbnail — including
// WhatsApp's own crawler fetching og:image — pays a full live Google
// Drive round-trip (~1.7–3.4s measured, sometimes more), which exceeds
// most link-preview crawlers' fetch timeout and is why the image never
// showed even after the OG tags themselves were fixed. Deliberately
// scoped to ONLY this route (not inside downloadFromStorage itself,
// which is shared with /stream and /download-file for full resource
// files) — thumbnails are small (under ~1MB each), full PDFs/videos are
// not, and caching those in RAM too could exhaust memory on a small
// Render instance.
//
// Simple Map, no TTL — thumbnails effectively never change once
// generated (see previewQueue.js), and a fixed entry cap keeps memory
// bounded on a small instance by evicting the oldest entry once full,
// rather than growing without limit as more resources get thumbnails.
const THUMBNAIL_CACHE_MAX_ENTRIES = 500
const thumbnailCache = new Map() // fileId -> { buffer, contentType }

function cacheThumbnail(fileId, buffer, contentType) {
  if (thumbnailCache.size >= THUMBNAIL_CACHE_MAX_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value
    thumbnailCache.delete(oldestKey)
  }
  thumbnailCache.set(fileId, { buffer, contentType })
}

// Re-encodes the raw thumbnail down to a capped width + compressed JPEG
// before caching. Confirmed via Meta's Sharing Debugger + direct WhatsApp
// tests: the original files here run ~850 kB, and even with the
// in-memory cache eliminating the slow Drive round-trip, WhatsApp's
// crawler STILL silently failed to render the image — its own fetch
// timeout is apparently tighter than what a file this size needs, even
// served instantly from RAM. 600px wide / quality 78 routinely lands
// under 100 kB with no visible quality loss at the size a link-preview
// card actually renders images.
async function loadAndCacheThumbnail(fileId) {
  const rawBuffer = await downloadFromStorage(fileId)
  let buffer
  let contentType
  try {
    buffer = await sharp(rawBuffer)
      .resize({ width: 600, withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer()
    contentType = 'image/jpeg'
  } catch (err) {
    // If the source isn't something sharp can decode, fall back to
    // serving the original untouched rather than failing the request.
    console.error(`Thumbnail compression failed for ${fileId}, serving original:`, err.message)
    buffer = rawBuffer
    contentType = sniffImageContentType(rawBuffer)
  }
  cacheThumbnail(fileId, buffer, contentType)
  return { buffer, contentType }
}

router.get('/:id/thumbnail', async (req, res) => {
  const result = await query(
    `SELECT thumbnail_file_id FROM resources WHERE id = $1`,
    [req.params.id]
  )
  const fileId = result.rows[0]?.thumbnail_file_id
  if (!fileId) return res.status(404).json({ error: 'No thumbnail available' })

  try {
    const cached = thumbnailCache.get(fileId) || (await loadAndCacheThumbnail(fileId))
    res.setHeader('Content-Type', cached.contentType)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(cached.buffer)
  } catch (err) {
    console.error(`Failed to load thumbnail for resource ${req.params.id}:`, err.message)
    res.status(502).json({ error: 'Failed to load thumbnail' })
  }
})

router.get('/:id', attachUser, async (req, res) => {
  const updated = await query(
    `UPDATE resources SET view_count = view_count + 1
     WHERE id = $1 AND status = 'approved'
     RETURNING id`,
    [req.params.id]
  )
  if (updated.rows.length === 0) return res.status(404).json({ error: 'Resource not found' })

  const detailResult = await query(
    `SELECT r.*, rt.slug AS type, rt.label AS type_label,
            c.name AS category, d.name AS department,
            CASE WHEN r.is_anonymous THEN NULL ELSE u.name END AS contributor_name,
            CASE WHEN r.is_anonymous THEN NULL ELSE u.avatar_url END AS contributor_avatar_url,
            (u.role IN ('admin', 'superadmin')) AS is_admin_upload
     FROM resources r
     JOIN resource_types rt ON rt.id = r.resource_type_id
     LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN departments d ON d.id = r.department_id
     LEFT JOIN users u ON u.id = r.uploaded_by
     WHERE r.id = $1`,
    [req.params.id]
  )

  const resource = detailResult.rows[0]

  let isBookmarked = false
  if (req.user) {
    const bookmarkResult = await query(
      'SELECT 1 FROM bookmarks WHERE user_id = $1 AND resource_id = $2',
      [req.user.id, req.params.id]
    )
    isBookmarked = bookmarkResult.rows.length > 0
  }

  res.json({ resource: { ...resource, is_bookmarked: isBookmarked } })
})

router.get('/:id/stream', attachUser, requireAuth, async (req, res) => {
  const resourceResult = await query(
    `SELECT file_id, file_name, file_type FROM resources WHERE id = $1 AND status = 'approved'`,
    [req.params.id]
  )
  if (resourceResult.rows.length === 0) return res.status(404).json({ error: 'Resource not found' })

  const { file_id, file_name, file_type } = resourceResult.rows[0]
  const needsPdfConversion = OFFICE_TO_PDF_MIME_TYPES.has(file_type)

  try {
    const buffer = needsPdfConversion
      ? await convertOfficeFileToPdf(file_id, file_type)
      : await downloadFromStorage(file_id)
    const totalSize = buffer.length
    const outputMimeType = needsPdfConversion ? 'application/pdf' : file_type
    const outputFileName = needsPdfConversion
      ? file_name.replace(/\.[^./\\]+$/, '') + '.pdf'
      : file_name

    res.setHeader('Content-Type', outputMimeType)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(outputFileName)}"`)

    const rangeHeader = req.headers.range

    if (!rangeHeader) {
      res.setHeader('Content-Length', totalSize)
      res.status(200).send(buffer)
      return
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
    if (!match || (!match[1] && !match[2])) {
      res.setHeader('Content-Range', `bytes */${totalSize}`)
      res.status(416).end()
      return
    }

    const start = match[1] ? parseInt(match[1], 10) : totalSize - parseInt(match[2], 10)
    const end = match[2] && match[1] ? Math.min(parseInt(match[2], 10), totalSize - 1) : totalSize - 1

    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || end >= totalSize) {
      res.setHeader('Content-Range', `bytes */${totalSize}`)
      res.status(416).end()
      return
    }

    const chunk = buffer.subarray(start, end + 1)
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`)
    res.setHeader('Content-Length', chunk.length)
    res.send(chunk)
  } catch (err) {
    console.error(`Failed to stream resource ${req.params.id}:`, err.message)
    res.status(502).json({ error: 'Failed to load file' })
  }
})

router.post('/:id/download', attachUser, requireAuth, async (req, res) => {
  const resourceResult = await query(
    `SELECT id, file_name FROM resources WHERE id = $1 AND status = 'approved'`,
    [req.params.id]
  )
  if (resourceResult.rows.length === 0) return res.status(404).json({ error: 'Resource not found' })

  await query('INSERT INTO downloads (user_id, resource_id) VALUES ($1, $2)', [req.user.id, req.params.id])
  await query('UPDATE resources SET download_count = download_count + 1 WHERE id = $1', [req.params.id])

  res.json({ ok: true, resourceId: resourceResult.rows[0].id, fileName: resourceResult.rows[0].file_name })
})

router.get('/:id/download-file', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `SELECT file_id, file_name, file_type FROM resources WHERE id = $1 AND status = 'approved'`,
    [req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Resource not found' })

  const { file_id, file_name, file_type } = result.rows[0]
  const needsPdfConversion = OFFICE_TO_PDF_MIME_TYPES.has(file_type)

  try {
    let buffer = needsPdfConversion
      ? await convertOfficeFileToPdf(file_id, file_type)
      : await downloadFromStorage(file_id)
    const outputMimeType = needsPdfConversion ? 'application/pdf' : file_type
    const outputFileName = needsPdfConversion
      ? file_name.replace(/\.[^./\\]+$/, '') + '.pdf'
      : file_name

    if (outputMimeType === 'application/pdf') {
      buffer = await watermarkPdf(buffer)
    }

    res.setHeader('Content-Type', outputMimeType)
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(outputFileName)}"`)
    res.send(buffer)
  } catch (err) {
    console.error(`Failed to prepare download for resource ${req.params.id}:`, err.message)
    res.status(502).json({ error: 'Failed to prepare file for offline download' })
  }
})

router.post('/:id/bookmark', attachUser, requireAuth, async (req, res) => {
  await query(
    `INSERT INTO bookmarks (user_id, resource_id, collection_id)
     VALUES ($1, $2, $3) ON CONFLICT (user_id, resource_id) DO NOTHING`,
    [req.user.id, req.params.id, req.body.collectionId || null]
  )
  res.json({ ok: true })
})

router.delete('/:id/bookmark', attachUser, requireAuth, async (req, res) => {
  await query('DELETE FROM bookmarks WHERE user_id = $1 AND resource_id = $2', [req.user.id, req.params.id])
  res.json({ ok: true })
})

router.put('/:id/progress', attachUser, requireAuth, async (req, res) => {
  const { progressPercent } = req.body
  await query(
    `INSERT INTO reading_history (user_id, resource_id, progress_percent, last_accessed_at, completed_at)
     VALUES ($1, $2, $3::smallint, now(), CASE WHEN $3::smallint >= 100 THEN now() ELSE NULL END)
     ON CONFLICT (user_id, resource_id)
     DO UPDATE SET progress_percent = $3::smallint, last_accessed_at = now(),
                    completed_at = CASE WHEN $3::smallint >= 100 THEN now() ELSE reading_history.completed_at END`,
    [req.user.id, req.params.id, progressPercent]
  )
  res.json({ ok: true })
})

export default router
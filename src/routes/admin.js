// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/admin.js
import { Router } from 'express'
import multer from 'multer'
import { query } from '../db/pool.js'
import { attachUser, requireAuth, requireRole, signPreviewToken, verifyPreviewToken } from '../middleware/auth.js'
import { deleteFromStorage, uploadToStorage, streamFromStorage } from '../services/storage.js'

const router = Router()

const REVIEW_LOCK_MINUTES = 15

async function logAction(actorId, action, entityType, entityId, metadata = {}) {
  await query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)`,
    [actorId, action, entityType, entityId, metadata]
  )
}

function lockIsActive(reviewingBy, reviewingStartedAt) {
  if (!reviewingBy || !reviewingStartedAt) return false
  const ageMinutes = (Date.now() - new Date(reviewingStartedAt).getTime()) / 60000
  return ageMinutes < REVIEW_LOCK_MINUTES
}

// GET /admin/uploads/:id/preview-stream?token=...
// Registered BEFORE the router-wide auth middleware below, on purpose —
// this is hit by <iframe>/<video>/<audio> src and by Google's docs
// viewer, none of which send our session cookie (iframe = cross-site,
// Google's viewer = a server fetching the URL with no cookies at all).
// Auth here is the short-lived signed token instead, scoped to this
// exact resource id, obtained via GET /admin/uploads/:id/preview-token
// (which DOES sit behind the normal cookie-authenticated middleware).
router.get('/uploads/:id/preview-stream', async (req, res) => {
  try {
    verifyPreviewToken(req.query.token, req.params.id)
  } catch {
    return res.status(401).json({ error: 'Invalid or expired preview token' })
  }

  const result = await query(`SELECT file_id, file_type FROM resources WHERE id = $1`, [req.params.id])
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' })

  const { file_id, file_type } = result.rows[0]
  const { data, mimeType } = await streamFromStorage(file_id)
  res.setHeader('Content-Type', mimeType || file_type || 'application/octet-stream')
  data.pipe(res)
})

router.use(attachUser, requireAuth, requireRole('admin', 'superadmin'))

// GET /admin/uploads/:id/preview-token — cookie-authenticated, issues the
// short-lived token used above.
router.get('/uploads/:id/preview-token', async (req, res) => {
  const result = await query(`SELECT id FROM resources WHERE id = $1`, [req.params.id])
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' })
  const token = signPreviewToken(req.params.id, req.user.id)
  res.json({ token })
})

// GET /admin/uploads/:id/lock-status — lightweight poll target so an
// open PreviewModal can detect it's been snatched by a superadmin and
// close itself automatically, instead of only discovering the loss of
// lock when Approve/Reject returns a 409.
router.get('/uploads/:id/lock-status', async (req, res) => {
  const result = await query(
    `SELECT reviewing_by, reviewing_started_at,
            rv.name AS reviewer_name, rv.email AS reviewer_email
     FROM resources r
     LEFT JOIN users rv ON rv.id = r.reviewing_by
     WHERE r.id = $1`,
    [req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' })

  const row = result.rows[0]
  const active = lockIsActive(row.reviewing_by, row.reviewing_started_at)
  res.json({
    reviewingBy: active ? row.reviewing_by : null,
    reviewerName: active ? row.reviewer_name : null,
    reviewerEmail: active ? row.reviewer_email : null,
  })
})

// GET /admin/dashboard
router.get('/dashboard', async (req, res) => {
  const [users, resources, downloads, pendingCount] = await Promise.all([
    query('SELECT COUNT(*) FROM users'),
    query(`SELECT COUNT(*) FROM resources WHERE status = 'approved'`),
    query('SELECT COUNT(*) FROM downloads'),
    query(`SELECT COUNT(*) FROM resources WHERE status = 'pending'`),
  ])
  res.json({
    totalUsers: Number(users.rows[0].count),
    totalResources: Number(resources.rows[0].count),
    totalDownloads: Number(downloads.rows[0].count),
    pendingReview: Number(pendingCount.rows[0].count),
  })
})

// GET /admin/uploads?search=&page= — now also returns the contributor's
// avatar (for the preview header) and, if actively locked, the
// reviewer's avatar/email — visible to every admin viewing the list, no
// click required. This is what makes the lock "passive": any admin
// looking at Pending already sees who's reviewing what.
router.get('/uploads', async (req, res) => {
  const { search = '', page = 1, pageSize = 10 } = req.query
  const limit = Math.min(Number(pageSize) || 10, 50)
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit

  const result = await query(
    `SELECT r.id, r.title, r.file_type, r.file_size_bytes, r.created_at,
            r.thumbnail_url, r.thumbnail_status, r.file_id,
            r.reviewing_by, r.reviewing_started_at,
            u.name AS contributor_name, u.email AS contributor_email, u.avatar_url AS contributor_avatar_url,
            rv.name AS reviewer_name, rv.email AS reviewer_email, rv.avatar_url AS reviewer_avatar_url
     FROM resources r
     JOIN users u ON u.id = r.uploaded_by
     LEFT JOIN users rv ON rv.id = r.reviewing_by
     WHERE r.status = 'pending'
       AND ($1 = '' OR r.title ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%')
     ORDER BY r.created_at ASC
     LIMIT $2 OFFSET $3`,
    [search, limit, offset]
  )

  const items = result.rows.map((row) => {
    const active = lockIsActive(row.reviewing_by, row.reviewing_started_at)
    return {
      ...row,
      reviewing_by: active ? row.reviewing_by : null,
      reviewer_name: active ? row.reviewer_name : null,
      reviewer_email: active ? row.reviewer_email : null,
      reviewer_avatar_url: active ? row.reviewer_avatar_url : null,
    }
  })

  res.json({ items })
})

// POST /admin/uploads/:id/claim
router.post('/uploads/:id/claim', async (req, res) => {
  const current = await query(
    `SELECT r.reviewing_by, r.reviewing_started_at, r.title,
            rv.name AS reviewer_name, rv.email AS reviewer_email, rv.avatar_url AS reviewer_avatar_url
     FROM resources r
     LEFT JOIN users rv ON rv.id = r.reviewing_by
     WHERE r.id = $1`,
    [req.params.id]
  )
  if (current.rows.length === 0) return res.status(404).json({ error: 'Resource not found' })

  const row = current.rows[0]
  const heldByOther = row.reviewing_by && row.reviewing_by !== req.user.id
  const isSuperadmin = req.user.role === 'superadmin'

  if (heldByOther && lockIsActive(row.reviewing_by, row.reviewing_started_at) && !isSuperadmin) {
    return res.status(409).json({
      error: 'Someone else is currently reviewing this item.',
      reviewer: { name: row.reviewer_name, email: row.reviewer_email, avatarUrl: row.reviewer_avatar_url },
    })
  }

  await query(
    `UPDATE resources SET reviewing_by = $1, reviewing_started_at = now() WHERE id = $2`,
    [req.user.id, req.params.id]
  )

  if (heldByOther && isSuperadmin) {
    await logAction(req.user.id, 'resource.review_snatch', 'resource', req.params.id, {
      previousReviewer: row.reviewing_by,
    })
    // Named + role-labeled explicitly, so the bumped admin knows exactly
    // who overrode them and why they no longer hold the lock — not just
    // a generic "a superadmin" with no name attached.
    await query(
      `INSERT INTO notifications (user_id, type, title, body, resource_id)
       VALUES ($1, 'review_snatched', $2, $3, $4)`,
      [
        row.reviewing_by,
        'A superadmin took over your review',
        `${req.user.name || req.user.email} (superadmin) took over your review of "${row.title}".`,
        req.params.id,
      ]
    )
  }

  res.json({ ok: true })
})

// POST /admin/uploads/:id/release
router.post('/uploads/:id/release', async (req, res) => {
  const current = await query(`SELECT reviewing_by FROM resources WHERE id = $1`, [req.params.id])
  if (current.rows.length === 0) return res.status(404).json({ error: 'Resource not found' })

  const { reviewing_by } = current.rows[0]
  if (reviewing_by && reviewing_by !== req.user.id && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'You do not hold the review lock on this item.' })
  }

  await query(`UPDATE resources SET reviewing_by = NULL, reviewing_started_at = NULL WHERE id = $1`, [req.params.id])
  res.json({ ok: true })
})

// PATCH /admin/uploads/:id/approve — reviewed_by is set here, so who
// approved a given resource is always on record (resources.reviewed_by,
// already in your schema). Surfaced in AdminResources' listing whenever
// you're ready to display it there — the data has been captured since
// this endpoint's original version, this just also clears the lock.
router.patch('/uploads/:id/approve', async (req, res) => {
  const lockCheck = await query(
    `SELECT reviewing_by, reviewing_started_at FROM resources WHERE id = $1 AND status = 'pending'`,
    [req.params.id]
  )
  if (lockCheck.rows.length === 0) return res.status(404).json({ error: 'Resource not found or already reviewed' })

  const { reviewing_by, reviewing_started_at } = lockCheck.rows[0]
  const heldByOther = reviewing_by && reviewing_by !== req.user.id
  if (heldByOther && lockIsActive(reviewing_by, reviewing_started_at) && req.user.role !== 'superadmin') {
    return res.status(409).json({ error: 'Another admin is currently reviewing this item.' })
  }

  const result = await query(
    `UPDATE resources SET status = 'approved', reviewed_by = $1, reviewed_at = now(),
            reviewing_by = NULL, reviewing_started_at = NULL
     WHERE id = $2 AND status = 'pending' RETURNING uploaded_by, title, thumbnail_url`,
    [req.user.id, req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Resource not found or already reviewed' })

  await logAction(req.user.id, 'resource.approve', 'resource', req.params.id)
  await query(
    `INSERT INTO notifications (user_id, type, title, body, link_to, thumbnail_url, resource_id)
     VALUES ($1, 'resource_approved', 'Your submission was approved', $2, $3, $4, $5)`,
    [
      result.rows[0].uploaded_by,
      `"${result.rows[0].title}" is now live in the library.`,
      `/resources/${req.params.id}`,
      result.rows[0].thumbnail_url,
      req.params.id,
    ]
  )
  res.json({ ok: true })
})

// PATCH /admin/uploads/:id/reject  { reason } — reviewed_by set here too.
router.patch('/uploads/:id/reject', async (req, res) => {
  const { reason } = req.body

  const lockCheck = await query(
    `SELECT reviewing_by, reviewing_started_at FROM resources WHERE id = $1 AND status = 'pending'`,
    [req.params.id]
  )
  if (lockCheck.rows.length === 0) return res.status(404).json({ error: 'Resource not found or already reviewed' })

  const { reviewing_by, reviewing_started_at } = lockCheck.rows[0]
  const heldByOther = reviewing_by && reviewing_by !== req.user.id
  if (heldByOther && lockIsActive(reviewing_by, reviewing_started_at) && req.user.role !== 'superadmin') {
    return res.status(409).json({ error: 'Another admin is currently reviewing this item.' })
  }

  const result = await query(
    `UPDATE resources SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), rejection_reason = $2,
            reviewing_by = NULL, reviewing_started_at = NULL
     WHERE id = $3 AND status = 'pending' RETURNING uploaded_by, title, file_id, thumbnail_url`,
    [req.user.id, reason || null, req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Resource not found or already reviewed' })

  const { file_id, thumbnail_url } = result.rows[0]

  try {
    await deleteFromStorage(file_id)
  } catch (err) {
    console.error(`Failed to delete rejected file ${file_id} from Drive:`, err.message)
  }

  if (thumbnail_url) {
    const match = thumbnail_url.match(/[?&]id=([^&]+)/)
    if (match) {
      try {
        await deleteFromStorage(match[1])
      } catch (err) {
        console.error(`Failed to delete rejected thumbnail for resource ${req.params.id}:`, err.message)
      }
    }
  }

  await logAction(req.user.id, 'resource.reject', 'resource', req.params.id, { reason })
  await query(
    `INSERT INTO notifications (user_id, type, title, body, thumbnail_url, resource_id)
     VALUES ($1, 'resource_rejected', 'Your submission needs changes', $2, $3, $4)`,
    [
      result.rows[0].uploaded_by,
      reason || `"${result.rows[0].title}" wasn't approved. Contact an admin for details.`,
      result.rows[0].thumbnail_url,
      req.params.id
    ]
  )
  res.json({ ok: true })
})

// GET /admin/resources?status=approved&search=&page= — now includes who
// reviewed each item, so approved/rejected history shows accountability.
router.get('/resources', async (req, res) => {
  const { status = 'approved', search = '', page = 1, pageSize = 15 } = req.query
  const limit = Math.min(Number(pageSize) || 15, 50)
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit

  const result = await query(
    `SELECT r.id, r.title, r.author, r.thumbnail_url, r.file_type, r.file_size_bytes,
            r.status, r.created_at, r.reviewed_at, u.name AS contributor_name,
            rv.name AS reviewed_by_name, rv.email AS reviewed_by_email
     FROM resources r
     JOIN users u ON u.id = r.uploaded_by
     LEFT JOIN users rv ON rv.id = r.reviewed_by
     WHERE r.status = $1
       AND ($2 = '' OR r.title ILIKE '%' || $2 || '%' OR u.name ILIKE '%' || $2 || '%')
     ORDER BY r.created_at DESC
     LIMIT $3 OFFSET $4`,
    [status, search, limit, offset]
  )
  res.json({ items: result.rows })
})

// DELETE /admin/resources/:id
router.delete('/resources/:id', async (req, res) => {
  const result = await query(
    `SELECT file_id, thumbnail_url, title FROM resources WHERE id = $1`,
    [req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Resource not found' })

  const { file_id, thumbnail_url, title } = result.rows[0]
  const driveErrors = []

  try {
    await deleteFromStorage(file_id)
  } catch (err) {
    console.error(`Failed to delete file ${file_id} from Drive:`, err.message)
    driveErrors.push({ target: 'file', fileId: file_id, message: err.message })
  }

  if (thumbnail_url) {
    const match = thumbnail_url.match(/[?&]id=([^&]+)/)
    if (match) {
      const thumbnailFileId = match[1]
      try {
        await deleteFromStorage(thumbnailFileId)
      } catch (err) {
        console.error(`Failed to delete thumbnail for resource ${req.params.id}:`, err.message)
        driveErrors.push({ target: 'thumbnail', fileId: thumbnailFileId, message: err.message })
      }
    } else {
      driveErrors.push({ target: 'thumbnail', fileId: null, message: 'Could not parse file ID from thumbnail_url' })
    }
  }

  await query('DELETE FROM resources WHERE id = $1', [req.params.id])
  await logAction(req.user.id, 'resource.delete', 'resource', req.params.id, {
    title,
    driveErrors: driveErrors.length ? driveErrors : undefined,
  })

  if (driveErrors.length > 0) {
    return res.status(207).json({
      ok: true,
      warning: 'Resource removed from the library, but one or more files could not be deleted from Drive.',
      driveErrors,
    })
  }
  res.json({ ok: true })
})

// GET /admin/users?search=&page=
router.get('/users', async (req, res) => {
  const { search = '', page = 1, pageSize = 15 } = req.query
  const limit = Math.min(Number(pageSize) || 15, 50)
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit

  const result = await query(
    `SELECT id, name, email, avatar_url, affiliation, category, institution_name,
            student_id, department, level, role, is_suspended, created_at, last_login_at
     FROM users
     WHERE ($1 = '' OR name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [search, limit, offset]
  )

  res.json({
    items: result.rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatar_url,
      affiliation: u.affiliation,
      category: u.category,
      institutionName: u.institution_name,
      studentId: u.student_id,
      department: u.department,
      level: u.level,
      role: u.role,
      isSuspended: u.is_suspended,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      profileComplete: Boolean(u.affiliation && u.category),
    })),
  })
})

// PATCH /admin/users/:id/role
router.patch('/users/:id/role', async (req, res) => {
  const { role } = req.body
  if (!['student', 'admin', 'superadmin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' })
  }
  if (role === 'superadmin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only a superadmin can grant superadmin' })
  }

  const result = await query('UPDATE users SET role = $1, updated_at = now() WHERE id = $2 RETURNING id, name',
    [role, req.params.id])
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

  await logAction(req.user.id, 'user.role_change', 'user', req.params.id, { newRole: role })
  res.json({ ok: true })
})

// PATCH /admin/users/:id/suspend
router.patch('/users/:id/suspend', async (req, res) => {
  const { suspended } = req.body
  if (typeof suspended !== 'boolean') {
    return res.status(400).json({ error: 'suspended must be a boolean' })
  }

  const result = await query(
    'UPDATE users SET is_suspended = $1, updated_at = now() WHERE id = $2 RETURNING id, name',
    [suspended, req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

  await logAction(req.user.id, suspended ? 'user.suspend' : 'user.unsuspend', 'user', req.params.id)
  res.json({ ok: true })
})

// GET /admin/requests
router.get('/requests', async (req, res) => {
  const result = await query(
    `SELECT mr.id, mr.title, mr.course_code, mr.notes, mr.created_at, u.name AS requester_name
     FROM material_requests mr
     JOIN users u ON u.id = mr.user_id
     WHERE mr.status = 'open'
     ORDER BY mr.created_at ASC`
  )
  res.json({ items: result.rows })
})

// PATCH /admin/requests/:id
router.patch('/requests/:id', async (req, res) => {
  const { status, fulfilledResourceId } = req.body
  if (!['fulfilled', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

  const result = await query(
    `UPDATE material_requests SET status = $1, resolved_by = $2, resolved_at = now(), fulfilled_resource_id = $3
     WHERE id = $4 RETURNING user_id, title`,
    [status, req.user.id, fulfilledResourceId || null, req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Request not found' })

  await logAction(req.user.id, 'request.resolve', 'material_request', req.params.id, { status })
  await query(
    `INSERT INTO notifications (user_id, type, title, body)
     VALUES ($1, 'request_resolved', $2, $3)`,
    [result.rows[0].user_id,
     status === 'fulfilled' ? 'Your request was fulfilled!' : 'Update on your request',
     `"${result.rows[0].title}" — ${status}.`]
  )
  res.json({ ok: true })
})

const announcementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedPrefixes = ['image/', 'application/pdf']
    const ok = allowedPrefixes.some((p) => file.mimetype.startsWith(p))
    if (!ok) return cb(new Error('Only image or PDF attachments are supported'))
    cb(null, true)
  },
})

router.post('/announcements/upload', announcementUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' })
  const category = req.file.mimetype.startsWith('image/') ? 'img' : 'doc'
  const stored = await uploadToStorage(req.file, category, { makePublic: false })
  const url = `${req.protocol}://${req.get('host')}/api/news/attachment/${stored.fileId}`
  res.status(201).json({ url, mime: req.file.mimetype })
})

router.get('/announcements', async (req, res) => {
  const { page = 1, pageSize = 20 } = req.query
  const limit = Math.min(Number(pageSize) || 20, 50)
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit

  const result = await query(
    `SELECT id, type, title, message, attachment_url, attachment_mime, send_email, created_at,
            starts_at, ends_at, daily_start_time, daily_end_time,
            popup_style, hidden_detail, link_url
     FROM announcements
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  )
  res.json({ items: result.rows })
})

router.post('/announcements', async (req, res) => {
  const {
    type, title, message, attachmentUrl, attachmentMime, sendEmail,
    startsAt, endsAt, dailyStartTime, dailyEndTime,
    popupStyle, hiddenDetail, linkUrl,
  } = req.body
  if (!['announcement', 'news', 'advert'].includes(type)) return res.status(400).json({ error: 'Invalid type' })
  if (!title?.trim() || !message?.trim()) return res.status(400).json({ error: 'Title and message are required' })

  const style = ['rich', 'image_only'].includes(popupStyle) ? popupStyle : 'rich'

  const inserted = await query(
    `INSERT INTO announcements (
       type, title, message, attachment_url, attachment_mime, send_email, created_by,
       starts_at, ends_at, daily_start_time, daily_end_time,
       popup_style, hidden_detail, link_url
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      type, title.trim(), message.trim(), attachmentUrl || null, attachmentMime || null, !!sendEmail, req.user.id,
      startsAt || null, endsAt || null, dailyStartTime || null, dailyEndTime || null,
      style, hiddenDetail?.trim() || null, linkUrl?.trim() || null,
    ]
  )

  await logAction(req.user.id, 'announcement.create', 'announcement', inserted.rows[0].id)
  res.status(201).json({ id: inserted.rows[0].id })
})

router.delete('/announcements/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM announcements WHERE id = $1 RETURNING attachment_url`,
    [req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' })

  const { attachment_url } = result.rows[0]
  if (attachment_url) {
    const match = attachment_url.match(/\/attachment\/([^/?#]+)/)
    if (match) {
      try {
        await deleteFromStorage(match[1])
      } catch (err) {
        console.error(`Failed to delete announcement attachment ${match[1]} from Drive:`, err.message)
      }
    }
  }

  await logAction(req.user.id, 'announcement.delete', 'announcement', req.params.id)
  res.json({ ok: true })
})

router.get('/analytics/most-requested', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50)
  try {
    const result = await query(
      `SELECT title, COUNT(*) AS request_count
       FROM material_requests
       GROUP BY title
       ORDER BY request_count DESC
       LIMIT $1`,
      [limit]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('Failed to fetch most-requested materials:', err)
    res.status(500).json({ error: 'Failed to fetch most-requested materials' })
  }
})

router.get('/analytics/most-viewed', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50)
  const windowParam = req.query.window || '7d'
  const intervalMap = { '7d': '7 days', '30d': '30 days' }
  const interval = intervalMap[windowParam]

  try {
    let result
    if (interval) {
      result = await query(
        `SELECT r.id, r.title, r.author, COUNT(v.id) AS view_count
         FROM resource_views v
         JOIN resources r ON r.id = v.resource_id
         WHERE v.viewed_at > now() - $1::interval
         GROUP BY r.id
         ORDER BY view_count DESC
         LIMIT $2`,
        [interval, limit]
      )
    } else {
      result = await query(
        `SELECT id, title, author, view_count
         FROM resources
         ORDER BY view_count DESC
         LIMIT $1`,
        [limit]
      )
    }
    res.json(result.rows)
  } catch (err) {
    console.error('Failed to fetch most-viewed resources:', err)
    res.status(500).json({ error: 'Failed to fetch most-viewed resources' })
  }
})

export default router
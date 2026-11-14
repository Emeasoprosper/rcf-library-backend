// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/admin.js
import { Router } from 'express'
import multer from 'multer'
import { query } from '../db/pool.js'
import { attachUser, requireAuth, requireRole, signPreviewToken, verifyPreviewToken } from '../middleware/auth.js'
import { deleteFromStorage, uploadToStorage, streamFromStorage } from '../services/storage.js'
import { findOrCreateAuthor } from '../services/authorLookup.js'
import { parseFilenameSignals } from '../utils/collectionDetector.js'
import { getRecentErrors } from '../services/errorLog.js'
import { sendPushToUser } from './community.js'
import { sendPush } from '../services/pushService.js'
import { getBotSettings, cleanBotSettings } from '../services/botSettings.js'
import { ensureGroupSettingsColumn, cleanGroupSettings, withGroupDefaults } from '../services/groupSettings.js'
import { ensureChatLogTables, chatLogUsage } from '../services/botChatLog.js'
import { isWhatsappRequest, readyMessage } from '../services/whatsappRequests.js'
import { ensureReviewColumns } from '../services/appReviews.js'
import { ensureAiTables, requestLectureNotes, retryJob, workerStatus } from '../services/aiLibrary.js'
import { notesProvider } from '../services/noteGenerator.js'

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
  const [users, resources, downloads, pendingCount, openRequests] = await Promise.all([
    query('SELECT COUNT(*) FROM users'),
    query(`SELECT COUNT(*) FROM resources WHERE status = 'approved'`),
    query('SELECT COUNT(*) FROM downloads'),
    query(`SELECT COUNT(*) FROM resources WHERE status = 'pending'`),
    query(`SELECT COUNT(*) FROM material_requests WHERE status = 'open'`),
  ])
  res.json({
    totalUsers: Number(users.rows[0].count),
    totalResources: Number(resources.rows[0].count),
    totalDownloads: Number(downloads.rows[0].count),
    pendingReview: Number(pendingCount.rows[0].count),
    openRequests: Number(openRequests.rows[0].count),
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
      `/library/${req.params.id}`,
      result.rows[0].thumbnail_url,
      req.params.id,
    ]
  )
  sendPushToUser(result.rows[0].uploaded_by, {
    title: '✅ Your submission was approved',
    body: `"${result.rows[0].title}" is now live in the library. Thank you for sharing!`,
    url: `/library/${req.params.id}`,
    image: result.rows[0].thumbnail_url || null,
  }).catch((err) => console.error('Push notify failed:', err.message))
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
  sendPushToUser(result.rows[0].uploaded_by, {
    title: 'Your submission needs changes',
    body: reason || `"${result.rows[0].title}" wasn't approved. Tap for details.`,
    url: '/contributions',
  }).catch((err) => console.error('Push notify failed:', err.message))
  await query(
    `INSERT INTO notifications (user_id, type, title, body, link_to, thumbnail_url, resource_id)
     VALUES ($1, 'resource_rejected', 'Your submission needs changes', $2, $3, $4, $5)`,
    [
      result.rows[0].uploaded_by,
      reason || `"${result.rows[0].title}" wasn't approved. Contact an admin for details.`,
      '/contributions',
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
            rv.name AS reviewed_by_name, rv.email AS reviewed_by_email,
            COALESCE(cats.names, ARRAY[]::text[]) AS categories
     FROM resources r
     JOIN users u ON u.id = r.uploaded_by
     LEFT JOIN users rv ON rv.id = r.reviewed_by
     LEFT JOIN LATERAL (
       SELECT array_agg(c2.name ORDER BY c2.name) AS names
       FROM resource_categories rc2
       JOIN categories c2 ON c2.id = rc2.category_id
       WHERE rc2.resource_id = r.id
     ) cats ON true
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
            student_id, department, level, role, is_suspended, created_at, last_login_at,
            gender, is_rcf_member, join_reason, heard_from
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
      gender: u.gender,
      isRcfMember: u.is_rcf_member,
      joinReason: u.join_reason,
      heardFrom: u.heard_from,
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

// GET /admin/resources/needs-organizing — every approved resource with
// no collection assigned yet (the leftover set the backfill scripts
// couldn't confidently auto-assign). Recomputes the same deterministic
// filename signals collectionDetector.js uses for new uploads, purely
// as a display hint — nothing here writes anything.
router.get('/resources/needs-organizing', async (req, res) => {
  const result = await query(
    `SELECT r.id, r.title, r.file_name, r.author, r.course_code, r.chapter, r.part, r.volume, r.edition,
            r.thumbnail_url, r.thumbnail_status, rt.slug AS resource_type_slug
     FROM resources r
     JOIN resource_types rt ON rt.id = r.resource_type_id
     WHERE r.status = 'approved' AND r.collection_id IS NULL
     ORDER BY r.created_at DESC`
  )

  const items = result.rows.map((r) => ({
    ...r,
    detected: parseFilenameSignals(r.file_name),
  }))

  res.json({ items })
})

// GET /admin/authors?search= — backs the author suggestion list on the
// Organize screen.
router.get('/authors', async (req, res) => {
  const { search = '' } = req.query
  const result = await query(
    `SELECT id, name FROM authors WHERE name ILIKE '%' || $1 || '%' ORDER BY name ASC LIMIT 50`,
    [search]
  )
  res.json({ items: result.rows })
})

// POST /admin/resource-collections — quick-create from the Organize screen.
router.post('/resource-collections', async (req, res) => {
  const { title, author } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
  const inserted = await query(
    `INSERT INTO resource_collections (title, author, created_by) VALUES ($1, $2, $3) RETURNING id, title, author, cover_url`,
    [title.trim(), author?.trim() || null, req.user.id]
  )
  res.status(201).json({ collection: inserted.rows[0] })
})

// PATCH /admin/resource-collections/:id — fixes a wrong title/author
// (e.g. accidentally typed as the author's name instead of the actual
// collection title). COALESCE means omitted fields are left untouched.
router.patch('/resource-collections/:id', async (req, res) => {
  const { title, author, description } = req.body
  await query(
    `UPDATE resource_collections SET
       title = COALESCE($1, title), author = COALESCE($2, author),
       description = COALESCE($3, description), updated_at = now()
     WHERE id = $4`,
    [title?.trim() || null, author?.trim() || null, description?.trim() || null, req.params.id]
  )
  res.json({ ok: true })
})

// DELETE /admin/resource-collections/:id — the collection row and its
// sections are removed; every resource that belonged to it is left
// completely intact, just automatically unlinked (collection_id /
// collection_section_id both fall back to NULL via the existing FK
// ON DELETE SET NULL) — it simply reappears in "Needs Organizing."
router.delete('/resource-collections/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM resource_collections WHERE id = $1 RETURNING title`,
    [req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Collection not found' })

  await logAction(req.user.id, 'collection.delete', 'resource_collection', req.params.id, {
    title: result.rows[0].title,
  })
  res.json({ ok: true })
})

// PATCH /admin/resources/:id/remove-from-collection — explicit NULL-out,
// distinct from PATCH .../organize which only ever fills in values via
// COALESCE and can never clear one. The resource itself is untouched —
// it just goes back to being unattached, same as if it had never been
// organized at all.
router.patch('/resources/:id/remove-from-collection', async (req, res) => {
  await query(
    `UPDATE resources SET collection_id = NULL, collection_section_id = NULL WHERE id = $1`,
    [req.params.id]
  )
  await logAction(req.user.id, 'resource.remove_from_collection', 'resource', req.params.id)
  res.json({ ok: true })
})

// POST /admin/resource-collections/:id/sections — quick-add a section.
router.post('/resource-collections/:id/sections', async (req, res) => {
  const { name } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Section name is required' })

  const existing = await query(
    `SELECT id, name FROM resource_collection_sections WHERE collection_id = $1 AND name ILIKE $2`,
    [req.params.id, name.trim()]
  )
  if (existing.rows.length > 0) return res.status(200).json({ section: existing.rows[0] })

  const countResult = await query(
    `SELECT COUNT(*) FROM resource_collection_sections WHERE collection_id = $1`, [req.params.id]
  )
  const inserted = await query(
    `INSERT INTO resource_collection_sections (collection_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id, name`,
    [req.params.id, name.trim(), Number(countResult.rows[0].count)]
  )
  res.status(201).json({ section: inserted.rows[0] })
})

// PATCH /admin/resources/:id/organize — assigns author/category/
// collection/section/chapter etc. COALESCE means any field left out of
// the request body keeps its current value rather than being wiped —
// the admin can fill in just what they know about a given resource.
// Simple, deterministic default when the admin just says "this belongs
// in that collection" without picking a section themselves — the admin
// only ever decides grouping, never section bookkeeping.
function defaultSectionName(resourceTypeSlug) {
  if (resourceTypeSlug === 'audio') return 'Audio'
  if (resourceTypeSlug === 'video') return 'Video'
  if (resourceTypeSlug === 'book') return 'Book'
  return 'General'
}

router.patch('/resources/:id/organize', async (req, res) => {
  const { authorName, categoryId, newCategoryName, collectionId, newCollectionTitle, sectionName, chapter, part, volume, edition } = req.body

  let finalAuthorId = null
  if (authorName?.trim()) {
    finalAuthorId = await findOrCreateAuthor(authorName.trim())
  }

  let finalCategoryId = categoryId || null
  if (!finalCategoryId && newCategoryName?.trim()) {
    const existingCat = await query(`SELECT id FROM categories WHERE name ILIKE $1`, [newCategoryName.trim()])
    finalCategoryId = existingCat.rows[0]?.id
      || (await query(`INSERT INTO categories (name) VALUES ($1) RETURNING id`, [newCategoryName.trim()])).rows[0].id
  }

  let finalCollectionId = collectionId || null
  if (!finalCollectionId && newCollectionTitle?.trim()) {
    const inserted = await query(
      `INSERT INTO resource_collections (title, author, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [newCollectionTitle.trim(), authorName?.trim() || null, req.user.id]
    )
    finalCollectionId = inserted.rows[0].id
  }

  // If the admin didn't specify a section, figure one out automatically
  // from the resource's own type — the admin's decision is just "this
  // goes with that folder"; the system handles the rest.
  let effectiveSectionName = sectionName?.trim() || null
  if (finalCollectionId && !effectiveSectionName) {
    const typeResult = await query(
      `SELECT rt.slug FROM resources r JOIN resource_types rt ON rt.id = r.resource_type_id WHERE r.id = $1`,
      [req.params.id]
    )
    effectiveSectionName = defaultSectionName(typeResult.rows[0]?.slug)
  }

  let finalSectionId = null
  if (finalCollectionId && effectiveSectionName) {
    const existingSection = await query(
      `SELECT id FROM resource_collection_sections WHERE collection_id = $1 AND name ILIKE $2`,
      [finalCollectionId, effectiveSectionName]
    )
    if (existingSection.rows.length > 0) {
      finalSectionId = existingSection.rows[0].id
    } else {
      const countResult = await query(
        `SELECT COUNT(*) FROM resource_collection_sections WHERE collection_id = $1`,
        [finalCollectionId]
      )
      finalSectionId = (await query(
        `INSERT INTO resource_collection_sections (collection_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id`,
        [finalCollectionId, effectiveSectionName, Number(countResult.rows[0].count)]
      )).rows[0].id
    }
  }

  await query(
    `UPDATE resources SET
       author_id = COALESCE($1, author_id),
       category_id = COALESCE($2, category_id),
       collection_id = COALESCE($3, collection_id),
       collection_section_id = COALESCE($4, collection_section_id),
       chapter = COALESCE($5, chapter),
       part = COALESCE($6, part),
       volume = COALESCE($7, volume),
       edition = COALESCE($8, edition)
     WHERE id = $9`,
    [finalAuthorId, finalCategoryId, finalCollectionId, finalSectionId, chapter || null, part || null, volume || null, edition || null, req.params.id]
  )

  await logAction(req.user.id, 'resource.organize', 'resource', req.params.id, req.body)
  res.json({ ok: true })
})

// GET /admin/birthdays — every member who has entered a birthday, in
// calendar order (Jan 1 first), for the month-by-month birthday list.
// `hidden` = they chose not to show it to other members (admins still see it).
router.get('/birthdays', async (req, res) => {
  const result = await query(
    `SELECT id, name, avatar_url, birth_month, birth_day,
            (birthday_public = false OR show_profile = false) AS hidden
     FROM users
     WHERE is_suspended = false AND birth_month BETWEEN 1 AND 12 AND birth_day BETWEEN 1 AND 31
     ORDER BY birth_month, birth_day, name`
  )
  res.json({
    items: result.rows.map((u) => ({
      id: u.id,
      name: u.name,
      avatarUrl: u.avatar_url,
      month: u.birth_month,
      day: u.birth_day,
      hidden: u.hidden,
    })),
  })
})

// GET /admin/requests — groups requests that are clearly about the same
// material (same course_code, or the exact same title once trimmed and
// lowercased) so the admin sees "4 students want this" instead of 4
// identical-looking cards. Deliberately exact-match only, not fuzzy or
// semantic — merging "Think and Grow Rich" with "Napoleon Hill's Think
// & Grow Rich" belongs to the AI collections/semantic-matching feature,
// not this one.
router.get('/requests', async (req, res) => {
  // Requests filed by Bro Paul from WhatsApp have no library user: their
  // WhatsApp name is shown instead.
  const result = await query(
    `SELECT mr.id, mr.title, mr.course_code, mr.notes, mr.details, mr.created_at,
            u.id AS requester_id,
            COALESCE(u.name, (COALESCE(mr.details->>'whatsappName', 'Someone') || ' (WhatsApp)')) AS requester_name,
            u.avatar_url AS requester_avatar_url
     FROM material_requests mr
     LEFT JOIN users u ON u.id = mr.user_id
     WHERE mr.status = 'open'
     ORDER BY mr.created_at ASC`
  )

  const groups = new Map()

  for (const row of result.rows) {
    const key = row.course_code
      ? `course:${row.course_code.trim().toLowerCase()}`
      : `title:${row.title.trim().toLowerCase()}`

    if (!groups.has(key)) {
      groups.set(key, {
        title: row.title,
        courseCode: row.course_code,
        createdAt: row.created_at, // earliest request in the group
        memberIds: [],
        requesters: [],
        notes: [],
        details: [],
      })
    }

    const group = groups.get(key)
    group.memberIds.push(row.id)
    group.requesters.push({ id: row.requester_id, name: row.requester_name, avatarUrl: row.requester_avatar_url })
    if (row.notes) group.notes.push(row.notes)
    if (row.details && Object.keys(row.details).length > 0) group.details.push(row.details)
  }

  // The AI lecture-notes job for each request, if one was started, so the
  // card can show "Writing… 45%", "Failed: Regenerate", etc.
  await ensureAiTables()
  const allIds = result.rows.map((r) => r.id)
  const jobs = allIds.length
    ? (
        await query(
          `SELECT DISTINCT ON (rid) rid, j.id, j.status, j.progress, j.step, j.error, j.resource_id, j.created_at, j.retry_after
           FROM ai_jobs j, unnest(j.request_ids) AS rid
           WHERE rid = ANY($1::uuid[])
           ORDER BY rid, j.created_at DESC`,
          [allIds]
        )
      ).rows
    : []
  const jobFor = (memberIds) => {
    const found = jobs.filter((j) => memberIds.includes(j.rid))
    if (!found.length) return null
    const j = found.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    return { id: j.id, status: j.status, progress: j.progress, step: j.step, error: j.error, resourceId: j.resource_id, waiting: Boolean(j.retry_after) }
  }

  const items = Array.from(groups.values()).map((g) => ({
    id: g.memberIds[0], // used only as a stable React key
    memberIds: g.memberIds,
    title: g.title,
    courseCode: g.courseCode,
    createdAt: g.createdAt,
    requestCount: g.memberIds.length,
    requesters: g.requesters,
    notes: g.notes,
    details: g.details,
    aiJob: jobFor(g.memberIds),
  }))

  res.json({ items })
})

// POST /admin/requests/generate-notes  { requestIds, courseCode?, title }
// Has the AI write lecture notes for a request (or writes them again). When
// done, everyone in the group gets the link and the request is fulfilled.
router.post('/requests/generate-notes', async (req, res) => {
  const requestIds = (Array.isArray(req.body.requestIds) ? req.body.requestIds : []).filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const title = String(req.body.title || '').trim()
  const courseCode = String(req.body.courseCode || '').trim() || null
  if (!requestIds.length || (!courseCode && title.length < 3)) return res.status(400).json({ error: 'Missing request or course.' })
  const result = await requestLectureNotes({ courseCode, title, requestIds, requestedBy: `Admin: ${req.user.name || 'admin'}`, force: true })
  if (result.status === 'unavailable') return res.status(503).json({ error: 'No AI key is set on the server (GEMINI_API_KEY).' })
  await logAction(req.user.id, 'ai_notes.create', 'material_request', requestIds[0], { courseCode, title })
  res.status(201).json(result)
})

// PATCH /admin/requests/:id


// PATCH /admin/requests/:id  { status, fulfilledResourceId?, reason? }
// fulfilledResourceId can be a raw ID or a full library link; the ID is
// extracted. Declining requires a reason. The student's notification carries
// the linked resource's link + cover (fulfilled) or the reason (declined).
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

router.patch('/requests/:id', async (req, res) => {
  const { status, fulfilledResourceId, reason } = req.body
  if (!['fulfilled', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

  const declineReason = reason?.trim() || null
  if (status === 'declined' && !declineReason) {
    return res.status(400).json({ error: 'Please give a reason for declining.' })
  }

  let linked = null
  if (status === 'fulfilled' && fulfilledResourceId?.trim()) {
    const match = fulfilledResourceId.match(UUID_RE)
    if (!match) return res.status(400).json({ error: 'That is not a valid resource link or ID.' })
    const found = await query(
      `SELECT id, title, thumbnail_url FROM resources WHERE id = $1 AND status = 'approved'`,
      [match[0]]
    )
    if (found.rows.length === 0) return res.status(404).json({ error: 'No approved resource found for that link.' })
    linked = found.rows[0]
  }

  const result = await query(
    `UPDATE material_requests SET status = $1, resolved_by = $2, resolved_at = now(), fulfilled_resource_id = $3
     WHERE id = $4 RETURNING user_id, title, details`,
    [status, req.user.id, linked?.id || null, req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Request not found' })

  await logAction(req.user.id, 'request.resolve', 'material_request', req.params.id, {
    status,
    reason: declineReason,
    resourceId: linked?.id,
  })

  // Asked on WhatsApp (no library account): Bro Paul tells them in a DM.
  const { user_id: requesterId, title: requestTitle, details } = result.rows[0]
  if (!requesterId) {
    if (isWhatsappRequest(details)) {
      const name = details.whatsappName ? ` ${details.whatsappName.split(' ')[0]}` : ''
      // Warm, never a refusal (see readyMessage in whatsappRequests.js).
      const text =
        status === 'fulfilled'
          ? readyMessage({ whatsappName: details.whatsappName, requestTitle, resourceId: linked?.id, resourceTitle: linked?.title })
          : `Hi${name}, about "${requestTitle}" that you asked for: the library team couldn't add it. Reason: ${declineReason}`
      await query(`INSERT INTO whatsapp_bot_outbox (group_jid, text, created_by) VALUES ($1, $2, $3)`, [details.whatsappId, text, req.user.id]).catch((err) =>
        console.error('WhatsApp request reply failed:', err.message)
      )
    }
    return res.json({ ok: true })
  }

  sendPushToUser(result.rows[0].user_id, {
    title: status === 'fulfilled' ? 'Your request was fulfilled!' : 'Update on your request',
    body:
      status === 'fulfilled'
        ? linked
          ? `"${linked.title}" is now in the library.`
          : `"${result.rows[0].title}" was fulfilled.`
        : `"${result.rows[0].title}" was declined. Reason: ${declineReason}`,
    url: linked ? `/library/${linked.id}` : '/contribute/request',
  }).catch((err) => console.error('Push notify failed:', err.message))

  if (status === 'fulfilled') {
    await query(
      `INSERT INTO notifications (user_id, type, title, body, link_to, thumbnail_url, resource_id)
       VALUES ($1, 'request_resolved', 'Your request was fulfilled!', $2, $3, $4, $5)`,
      [
        result.rows[0].user_id,
        linked
          ? `"${linked.title}" is now in the library. Tap to open it.`
          : `"${result.rows[0].title}" — fulfilled.`,
        linked ? `/library/${linked.id}` : null,
        linked?.thumbnail_url || null,
        linked?.id || null,
      ]
    )
  } else {
    await query(
      `INSERT INTO notifications (user_id, type, title, body, link_to)
       VALUES ($1, 'request_resolved', 'Update on your request', $2, $3)`,
      [result.rows[0].user_id, `"${result.rows[0].title}" was declined. Reason: ${declineReason}`, '/contribute/request']
    )
  }

  res.json({ ok: true })
})

// POST /admin/resource-collections/:id/cover — uploads privately
// (makePublic: false) and stores stored.fileId in cover_file_id, exactly
// the same pattern resources.js already uses for resource thumbnails
// (thumbnail_file_id -> GET /:id/thumbnail proxy). cover_url now holds
// OUR OWN proxy URL, never a raw Drive link, so it's never subject to
// Drive's hotlink/permission quirks that made the image intermittently
// fail to render.
const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are supported'))
    cb(null, true)
  },
})

router.post('/resource-collections/:id/cover', coverUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' })

  const stored = await uploadToStorage(req.file, 'img', { makePublic: false })
  const coverUrl = `${req.protocol}://${req.get('host')}/api/resource-collections/${req.params.id}/cover`
  await query(`UPDATE resource_collections SET cover_file_id = $1, cover_url = $2, updated_at = now() WHERE id = $3`, [
    stored.fileId,
    coverUrl,
    req.params.id,
  ])

  res.json({ coverUrl })
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
            popup_style, hidden_detail, link_url,
            post_to_whatsapp, whatsapp_repeat_hours, whatsapp_posted_at
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
    postToWhatsapp, whatsappRepeatHours,
  } = req.body
  if (!['announcement', 'news', 'advert'].includes(type)) return res.status(400).json({ error: 'Invalid type' })
  if (!title?.trim() || !message?.trim()) return res.status(400).json({ error: 'Title and message are required' })

  const style = ['rich', 'image_only'].includes(popupStyle) ? popupStyle : 'rich'
  // Repeats are capped at once every 6h so the bot can't be set to spam the group.
  const repeatHours = Number(whatsappRepeatHours)
  const whatsappRepeat = postToWhatsapp && Number.isInteger(repeatHours) && repeatHours > 0
    ? Math.max(repeatHours, 6)
    : null

  const inserted = await query(
    `INSERT INTO announcements (
       type, title, message, attachment_url, attachment_mime, send_email, created_by,
       starts_at, ends_at, daily_start_time, daily_end_time,
       popup_style, hidden_detail, link_url,
       post_to_whatsapp, whatsapp_repeat_hours
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [
      type, title.trim(), message.trim(), attachmentUrl || null, attachmentMime || null, !!sendEmail, req.user.id,
      startsAt || null, endsAt || null, dailyStartTime || null, dailyEndTime || null,
      style, hiddenDetail?.trim() || null, linkUrl?.trim() || null,
      !!postToWhatsapp, whatsappRepeat,
    ]
  )

  await logAction(req.user.id, 'announcement.create', 'announcement', inserted.rows[0].id)

  // Adverts never push. Scheduled-for-later posts are skipped (no push when they go live yet).
  const pushCategory = type === 'news' ? 'news' : type === 'announcement' ? 'announcements' : null
  const notStartedYet = startsAt && new Date(startsAt).getTime() > Date.now()
  if (pushCategory && !notStartedYet) {
    sendPush({
      category: pushCategory,
      title: title.trim(),
      body: message.trim().slice(0, 140),
      url: `/news/${inserted.rows[0].id}`,
      tag: `ann-${inserted.rows[0].id}`,
      image: attachmentMime && attachmentMime.startsWith('image/') ? attachmentUrl : null,
    }).catch((err) => console.error('Announcement push failed:', err.message))
  }
  res.status(201).json({ id: inserted.rows[0].id })
})

// PATCH /admin/announcements/:id/whatsapp — turn group posting on/off later
// (e.g. stop a repeating advert without deleting it from the app).
router.patch('/announcements/:id/whatsapp', async (req, res) => {
  const enabled = !!req.body.postToWhatsapp
  const result = await query(
    `UPDATE announcements SET post_to_whatsapp = $2 WHERE id = $1 RETURNING id, post_to_whatsapp`,
    [req.params.id, enabled]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' })
  await logAction(req.user.id, enabled ? 'announcement.whatsapp_on' : 'announcement.whatsapp_off', 'announcement', req.params.id)
  res.json(result.rows[0])
})

router.delete('/announcements/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM announcements WHERE id = $1 RETURNING attachment_url, music_file_id`,
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

  const musicFileId = result.rows[0].music_file_id
  if (musicFileId) {
    try {
      await deleteFromStorage(musicFileId)
    } catch (err) {
      console.error(`Failed to delete announcement music ${musicFileId} from Drive:`, err.message)
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

// GET /admin/home-rails — every admin-curated rail, including inactive
// ones, for the management screen.
router.get('/home-rails', async (req, res) => {
  const railsResult = await query(`SELECT id, title, sort_order, is_active, image_url FROM home_rails ORDER BY sort_order ASC`)
  const itemsResult = await query(
    `SELECT hri.rail_id, r.id, r.title, r.author, r.thumbnail_url,
            COALESCE(cats.names, ARRAY[]::text[]) AS categories
     FROM home_rail_items hri
     JOIN resources r ON r.id = hri.resource_id
     LEFT JOIN LATERAL (
       SELECT array_agg(c2.name ORDER BY c2.name) AS names
       FROM resource_categories rc2
       JOIN categories c2 ON c2.id = rc2.category_id
       WHERE rc2.resource_id = r.id
     ) cats ON true
     ORDER BY hri.sort_order ASC`
  )
  const itemsByRail = new Map()
  for (const row of itemsResult.rows) {
    if (!itemsByRail.has(row.rail_id)) itemsByRail.set(row.rail_id, [])
    itemsByRail.get(row.rail_id).push({ id: row.id, title: row.title, author: row.author, thumbnail_url: row.thumbnail_url, categories: row.categories || [] })
  }
  res.json({
    items: railsResult.rows.map((r) => ({ ...r, resources: itemsByRail.get(r.id) || [] })),
  })
})

// POST /admin/home-rails  { title }
router.post('/home-rails', async (req, res) => {
  const { title } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
  const countResult = await query('SELECT COUNT(*) FROM home_rails')
  const inserted = await query(
    `INSERT INTO home_rails (title, sort_order, created_by) VALUES ($1, $2, $3) RETURNING id, title, sort_order, is_active`,
    [title.trim(), Number(countResult.rows[0].count), req.user.id]
  )
  res.status(201).json({ rail: { ...inserted.rows[0], resources: [] } })
})

// PATCH /admin/home-rails/:id  { title?, isActive?, sortOrder? }
router.patch('/home-rails/:id', async (req, res) => {
  const { title, isActive, sortOrder, imageUrl } = req.body
  await query(
    `UPDATE home_rails SET
       title = COALESCE($1, title),
       is_active = COALESCE($2, is_active),
       sort_order = COALESCE($3, sort_order),
       image_url = COALESCE($4, image_url)
     WHERE id = $5`,
    [title?.trim() || null, typeof isActive === 'boolean' ? isActive : null, sortOrder ?? null, imageUrl || null, req.params.id]
  )
  res.json({ ok: true })
})

router.post('/home-rails/:id/image', coverUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' })

  const existing = await query(`SELECT image_file_id FROM home_rails WHERE id = $1`, [req.params.id])
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Rail not found' })

  const stored = await uploadToStorage(req.file, 'img', { makePublic: false })
  const imageUrl = `${req.protocol}://${req.get('host')}/api/resources/home-rails/${req.params.id}/image?v=${Date.now()}`
  await query(`UPDATE home_rails SET image_file_id = $1, image_url = $2 WHERE id = $3`, [
    stored.fileId,
    imageUrl,
    req.params.id,
  ])

  const oldFileId = existing.rows[0].image_file_id
  if (oldFileId) {
    try {
      await deleteFromStorage(oldFileId)
    } catch (err) {
      console.error(`Failed to delete old rail image ${oldFileId} from Drive:`, err.message)
    }
  }

  res.json({ imageUrl })
})

// DELETE /admin/home-rails/:id
router.delete('/home-rails/:id', async (req, res) => {
  await query('DELETE FROM home_rails WHERE id = $1', [req.params.id])
  res.json({ ok: true })
})

// POST /admin/home-rails/:id/items  { resourceId }
router.post('/home-rails/:id/items', async (req, res) => {
  const { resourceId } = req.body
  if (!resourceId) return res.status(400).json({ error: 'resourceId is required' })
  const countResult = await query('SELECT COUNT(*) FROM home_rail_items WHERE rail_id = $1', [req.params.id])
  await query(
    `INSERT INTO home_rail_items (rail_id, resource_id, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [req.params.id, resourceId, Number(countResult.rows[0].count)]
  )
  res.json({ ok: true })
})

// DELETE /admin/home-rails/:id/items/:resourceId
router.delete('/home-rails/:id/items/:resourceId', async (req, res) => {
  await query('DELETE FROM home_rail_items WHERE rail_id = $1 AND resource_id = $2', [req.params.id, req.params.resourceId])
  res.json({ ok: true })
})


// PATCH /admin/settings/online-indicator  { enabled }
router.patch('/settings/online-indicator', async (req, res) => {
  const { enabled } = req.body
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' })
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('online_indicator_enabled', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [String(enabled)]
  )
  res.json({ ok: true, enabled })
})

// GET /admin/ratings-summary — average + count, admin-only.
router.get('/ratings-summary', async (req, res) => {
  const result = await query(
    `SELECT COUNT(*)::int AS count, COALESCE(AVG(stars), 0)::float AS average FROM app_ratings`
  )
  res.json(result.rows[0])
})

// ---------- AI Library ----------
// GET /admin/ai-library — jobs (newest first), books the AI wrote, books
// Bro Paul uploaded, the switches and which AI is writing.
router.get('/ai-library', async (req, res) => {
  await ensureAiTables()
  const [jobs, books, settings, groups] = await Promise.all([
    query(
      `SELECT j.id, j.course_code, j.title, j.status, j.progress, j.step, j.error, j.provider, j.requested_by,
              cardinality(j.request_ids) AS requesters, j.created_at, j.started_at, j.finished_at, j.retry_after,
              j.resource_id, r.title AS resource_title
       FROM ai_jobs j LEFT JOIN resources r ON r.id = j.resource_id
       ORDER BY (j.status IN ('queued', 'running')) DESC, j.created_at DESC LIMIT 60`
    ),
    query(
      `SELECT r.id, r.title, r.author, r.course_code, r.status, r.ai_origin, r.thumbnail_url, r.created_at,
              r.description, r.download_count, t.slug AS type
       FROM resources r LEFT JOIN resource_types t ON t.id = r.resource_type_id
       WHERE r.ai_origin IS NOT NULL ORDER BY r.created_at DESC LIMIT 200`
    ).catch(() =>
      query(
        `SELECT r.id, r.title, r.author, r.course_code, r.status, r.ai_origin, r.thumbnail_url, r.created_at, r.description, t.slug AS type
         FROM resources r LEFT JOIN resource_types t ON t.id = r.resource_type_id
         WHERE r.ai_origin IS NOT NULL ORDER BY r.created_at DESC LIMIT 200`
      )
    ),
    getBotSettings(),
    query(`SELECT jid, name, enabled, settings FROM whatsapp_groups WHERE coalesce((settings->>'left')::boolean, false) = false ORDER BY name`).catch(() => ({ rows: [] })),
  ])
  const provider = notesProvider()
  res.json({
    provider: provider ? { ...provider, paid: provider.name === 'claude' } : null,
    worker: await workerStatus(),
    settings: {
      aiLectureNotes: settings.aiLectureNotes,
      aiNotesAutoPublish: settings.aiNotesAutoPublish,
      askForMaterials: settings.askForMaterials,
      autoUploadMaterials: settings.autoUploadMaterials,
      autoPublishUploads: settings.autoPublishUploads,
    },
    canEdit: req.user.role === 'superadmin',
    jobs: jobs.rows,
    books: books.rows,
    groups: groups.rows.map((g) => ({ jid: g.jid, name: g.name, enabled: g.enabled, askForMaterials: g.settings?.askForMaterials === true })),
  })
})

// POST /admin/ai-library/notes  { courseCode, title, level } — write notes now
// (even if the library already has some for that course).
router.post('/ai-library/notes', async (req, res) => {
  const courseCode = String(req.body.courseCode || '').trim()
  const title = String(req.body.title || '').trim()
  if (!courseCode && title.length < 3) return res.status(400).json({ error: 'Give a course code or a course title.' })
  const result = await requestLectureNotes({
    courseCode: courseCode || null,
    title: title || courseCode,
    level: String(req.body.level || '').trim() || null,
    requestedBy: `Admin: ${req.user.name || 'admin'}`,
    force: true,
  })
  if (result.status === 'unavailable') return res.status(503).json({ error: 'No AI key is set on the server (GEMINI_API_KEY).' })
  await logAction(req.user.id, 'ai_notes.create', 'ai_job', result.jobId || '', { courseCode, title })
  res.status(201).json(result)
})

// POST /admin/ai-library/jobs/:id/retry — run a failed job again.
router.post('/ai-library/jobs/:id/retry', async (req, res) => {
  if (!(await retryJob(req.params.id))) return res.status(404).json({ error: 'Only failed jobs can be retried.' })
  await logAction(req.user.id, 'ai_notes.retry', 'ai_job', req.params.id)
  res.json({ ok: true })
})

// PATCH /admin/ai-library/resources/:id  { status: 'approved' | 'pending' } — publish or hide one.
router.patch('/ai-library/resources/:id', async (req, res) => {
  const status = req.body.status === 'approved' ? 'approved' : 'pending'
  const r = await query(
    `UPDATE resources SET status = $2::resource_status, reviewed_by = $3, reviewed_at = now()
     WHERE id = $1 AND ai_origin IS NOT NULL RETURNING id`,
    [req.params.id, status, req.user.id]
  )
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' })
  await logAction(req.user.id, status === 'approved' ? 'ai_book.publish' : 'ai_book.hide', 'resource', req.params.id)
  res.json({ ok: true, status })
})

// GET /admin/reviews?kind=review|complaint&stars=1..5&before=<iso>
// The reviews page: summary (average, count, 1-5 breakdown, complaints,
// last-30-days average) plus the newest 50 matching entries.
router.get('/reviews', async (req, res) => {
  await ensureReviewColumns()
  const kind = ['review', 'complaint'].includes(req.query.kind) ? req.query.kind : null
  const stars = Number(req.query.stars) >= 1 && Number(req.query.stars) <= 5 ? Number(req.query.stars) : null
  const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null

  const [summary, dist, rows] = await Promise.all([
    query(`SELECT COUNT(*)::int AS count,
                  COALESCE(AVG(stars), 0)::float AS average,
                  COUNT(*) FILTER (WHERE kind = 'complaint')::int AS complaints,
                  COUNT(*) FILTER (WHERE kind = 'complaint' AND resolved_at IS NULL)::int AS open_complaints,
                  COUNT(*) FILTER (WHERE review IS NOT NULL)::int AS written,
                  COALESCE(AVG(stars) FILTER (WHERE created_at > now() - interval '30 days'), 0)::float AS average_30d,
                  COALESCE(AVG(stars) FILTER (WHERE created_at BETWEEN now() - interval '60 days' AND now() - interval '30 days'), 0)::float AS average_prev_30d
           FROM app_ratings`),
    query(`SELECT stars, COUNT(*)::int AS n FROM app_ratings GROUP BY stars`),
    query(
      `SELECT r.id, r.stars, r.review, r.kind, r.tags, r.trigger, r.created_at, r.resolved_at,
              u.id AS user_id, u.name AS user_name, u.avatar_url AS user_avatar
       FROM app_ratings r JOIN users u ON u.id = r.user_id
       WHERE ($1::text IS NULL OR r.kind = $1)
         AND ($2::int IS NULL OR r.stars = $2)
         AND ($3::timestamptz IS NULL OR r.created_at < $3)
       ORDER BY r.created_at DESC LIMIT 50`,
      [kind, stars, before]
    ),
  ])

  const distribution = [1, 2, 3, 4, 5].map((s) => dist.rows.find((r) => r.stars === s)?.n || 0)
  res.json({
    summary: { ...summary.rows[0], distribution },
    items: rows.rows.map((r) => ({
      id: r.id,
      stars: r.stars,
      review: r.review,
      kind: r.kind,
      tags: r.tags || [],
      trigger: r.trigger,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      user: { id: r.user_id, name: r.user_name, avatarUrl: r.user_avatar },
    })),
  })
})

// PATCH /admin/reviews/:id  { resolved: boolean } — mark a complaint handled.
router.patch('/reviews/:id', async (req, res) => {
  await ensureReviewColumns()
  const result = await query(
    `UPDATE app_ratings SET resolved_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 RETURNING id, resolved_at`,
    [req.params.id, Boolean(req.body?.resolved)]
  )
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' })
  await logAction(req.user.id, req.body?.resolved ? 'review.resolve' : 'review.reopen', 'app_rating', req.params.id)
  res.json({ ok: true, resolvedAt: result.rows[0].resolved_at })
})

// GET /admin/feedback
router.get('/feedback', async (req, res) => {
  const result = await query(
    `SELECT af.id, af.type, af.message, af.created_at, u.name AS user_name, u.email AS user_email
     FROM app_feedback af JOIN users u ON u.id = af.user_id
     ORDER BY af.created_at DESC LIMIT 100`
  )
  res.json({ items: result.rows })
})

// GET /admin/registration-stats — aggregate breakdowns for the charts.
router.get('/registration-stats', async (req, res) => {
  const [gender, rcf, heardFrom, joinReason] = await Promise.all([
    query(`SELECT gender, COUNT(*)::int AS count FROM users WHERE gender IS NOT NULL GROUP BY gender`),
    query(`SELECT is_rcf_member, COUNT(*)::int AS count FROM users WHERE is_rcf_member IS NOT NULL GROUP BY is_rcf_member`),
    query(`SELECT heard_from, COUNT(*)::int AS count FROM users WHERE heard_from IS NOT NULL GROUP BY heard_from ORDER BY count DESC`),
    query(`SELECT join_reason, COUNT(*)::int AS count FROM users WHERE join_reason IS NOT NULL GROUP BY join_reason ORDER BY count DESC`),
  ])
  res.json({
    gender: gender.rows,
    rcf: rcf.rows,
    heardFrom: heardFrom.rows,
    joinReason: joinReason.rows,
  })
})

// GET /admin/system/errors — recent server errors (in-memory, superadmin only).
// ---------- WhatsApp bot (Bro Paul), superadmin only ----------

// A heartbeat older than this means the bot process is down.
const BOT_STALE_SECONDS = 120

// GET /admin/whatsapp — bot status, QR to scan (while linking), and groups.
router.get('/whatsapp', requireRole('superadmin'), async (req, res) => {
  await ensureGroupSettingsColumn()
  const [status, groups] = await Promise.all([
    query(
      `SELECT state, qr_data_url, phone, relink_requested, updated_at,
              (updated_at < now() - make_interval(secs => $1)) AS stale
       FROM whatsapp_bot_status WHERE id = 1`,
      [BOT_STALE_SECONDS]
    ),
    query(`SELECT jid, name, enabled, member_count, added_at, last_seen_at, settings FROM whatsapp_groups ORDER BY added_at DESC`),
  ])
  const row = status.rows[0] || { state: 'offline' }
  const state = row.stale ? 'offline' : row.state
  res.json({
    state,
    qrDataUrl: state === 'qr' ? row.qr_data_url : null,
    phone: row.phone || null,
    relinkRequested: !!row.relink_requested,
    updatedAt: row.updated_at || null,
    groups: groups.rows.map((g) => ({ ...g, settings: withGroupDefaults(g.settings) })),
  })
})

// POST /admin/whatsapp/relink — bot logs out and shows a fresh QR here.
router.post('/whatsapp/relink', requireRole('superadmin'), async (req, res) => {
  await query(`UPDATE whatsapp_bot_status SET relink_requested = TRUE WHERE id = 1`)
  await logAction(req.user.id, 'whatsapp.relink', 'whatsapp_bot', '1')
  res.json({ ok: true })
})

// PATCH /admin/whatsapp/groups/:jid  { enabled?, settings? }
// settings = who the group is for and which posts are allowed there (see
// services/groupSettings.js); only the keys sent are changed.
router.patch('/whatsapp/groups/:jid', requireRole('superadmin'), async (req, res) => {
  await ensureGroupSettingsColumn()
  const hasEnabled = typeof req.body.enabled === 'boolean'
  const settings = req.body.settings ? cleanGroupSettings(req.body.settings) : {}
  const result = await query(
    `UPDATE whatsapp_groups
       SET enabled = CASE WHEN $2::boolean IS NULL THEN enabled ELSE $2::boolean END,
           settings = settings || $3::jsonb
     WHERE jid = $1
     RETURNING jid, enabled, settings`,
    [req.params.jid, hasEnabled ? req.body.enabled : null, JSON.stringify(settings)]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Group not found' })
  if (hasEnabled) await logAction(req.user.id, req.body.enabled ? 'whatsapp.group_on' : 'whatsapp.group_off', 'whatsapp_group', req.params.jid)
  if (Object.keys(settings).length) await logAction(req.user.id, 'whatsapp.group_settings', 'whatsapp_group', req.params.jid)
  const row = result.rows[0]
  res.json({ ...row, settings: withGroupDefaults(row.settings) })
})

// ---------- Bro Paul Control Center, superadmin only ----------

// GET/PUT /admin/whatsapp/settings — feature switches (bot reloads every minute)
router.get('/whatsapp/settings', requireRole('superadmin'), async (req, res) => {
  res.json({ settings: await getBotSettings() })
})

router.put('/whatsapp/settings', requireRole('superadmin'), async (req, res) => {
  const current = await getBotSettings()
  const next = { ...current, ...cleanBotSettings(req.body?.settings || {}) }
  if (next.activeToHour <= next.activeFromHour) {
    return res.status(400).json({ error: 'The "until" hour must be after the "from" hour.' })
  }
  await query(
    `UPDATE whatsapp_bot_settings SET settings = $1::jsonb, updated_by = $2, updated_at = now() WHERE id = 1`,
    [JSON.stringify(next), req.user.id]
  )
  await logAction(req.user.id, 'whatsapp.settings', 'whatsapp_bot', '1', next)
  res.json({ settings: next })
})

// Facts: verified RCF information the AI may share (service times, exco, events).
router.get('/whatsapp/facts', requireRole('superadmin'), async (req, res) => {
  const result = await query(`SELECT id, title, text, updated_at FROM whatsapp_bot_facts ORDER BY created_at ASC`)
  res.json({ items: result.rows })
})

function cleanFact(body) {
  const title = String(body?.title || '').trim().slice(0, 80)
  const text = String(body?.text || '').trim().slice(0, 600)
  return title && text ? { title, text } : null
}

router.post('/whatsapp/facts', requireRole('superadmin'), async (req, res) => {
  const fact = cleanFact(req.body)
  if (!fact) return res.status(400).json({ error: 'A title and the information are both required.' })
  const count = await query(`SELECT COUNT(*)::int AS n FROM whatsapp_bot_facts`)
  if (count.rows[0].n >= 100) return res.status(400).json({ error: 'You can save up to 100 facts.' })
  const result = await query(
    `INSERT INTO whatsapp_bot_facts (title, text, created_by) VALUES ($1, $2, $3) RETURNING id, title, text, updated_at`,
    [fact.title, fact.text, req.user.id]
  )
  await logAction(req.user.id, 'whatsapp.fact_add', 'whatsapp_fact', result.rows[0].id)
  res.status(201).json(result.rows[0])
})

router.patch('/whatsapp/facts/:id', requireRole('superadmin'), async (req, res) => {
  const fact = cleanFact(req.body)
  if (!fact) return res.status(400).json({ error: 'A title and the information are both required.' })
  const result = await query(
    `UPDATE whatsapp_bot_facts SET title = $2, text = $3, updated_at = now() WHERE id = $1 RETURNING id, title, text, updated_at`,
    [req.params.id, fact.title, fact.text]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Fact not found' })
  await logAction(req.user.id, 'whatsapp.fact_edit', 'whatsapp_fact', req.params.id)
  res.json(result.rows[0])
})

router.delete('/whatsapp/facts/:id', requireRole('superadmin'), async (req, res) => {
  const result = await query(`DELETE FROM whatsapp_bot_facts WHERE id = $1 RETURNING id`, [req.params.id])
  if (result.rows.length === 0) return res.status(404).json({ error: 'Fact not found' })
  await logAction(req.user.id, 'whatsapp.fact_delete', 'whatsapp_fact', req.params.id)
  res.json({ ok: true })
})

// Send as Bro Paul: queued here, the bot picks it up within ~20 seconds.
router.post('/whatsapp/send', requireRole('superadmin'), async (req, res) => {
  const jid = String(req.body?.jid || '')
  const text = String(req.body?.text || '').trim().slice(0, 3000)
  if (!text) return res.status(400).json({ error: 'Type a message first.' })
  const group = await query(`SELECT jid FROM whatsapp_groups WHERE jid = $1`, [jid])
  if (group.rows.length === 0) return res.status(400).json({ error: 'Pick a group Bro Paul is in.' })
  const result = await query(
    `INSERT INTO whatsapp_bot_outbox (group_jid, text, created_by) VALUES ($1, $2, $3) RETURNING id, status, created_at`,
    [jid, text, req.user.id]
  )
  await logAction(req.user.id, 'whatsapp.send', 'whatsapp_group', jid)
  res.status(201).json(result.rows[0])
})

router.get('/whatsapp/outbox', requireRole('superadmin'), async (req, res) => {
  const result = await query(
    `SELECT o.id, o.group_jid, g.name AS group_name, o.text, o.status, o.error, o.created_at, o.sent_at
     FROM whatsapp_bot_outbox o LEFT JOIN whatsapp_groups g ON g.jid = o.group_jid
     ORDER BY o.created_at DESC LIMIT 20`
  )
  res.json({ items: result.rows })
})

// Activity categories in the admin app, by the kinds the bot logs.
const ACTIVITY_CATEGORIES = {
  private: ['private'],
  posts: ['morning', 'featured', 'promo', 'new-month', 'welcome', 'intro', 'cleanup'],
  announcements: ['announcement', 'send'],
  replies: ['reply', 'search', 'chime', 'prayer', 'request', 'upload'],
  reactions: ['react', 'sticker', 'birthday'],
}

// GET /admin/whatsapp/activity?category=posts — newest first
router.get('/whatsapp/activity', requireRole('superadmin'), async (req, res) => {
  const kinds = ACTIVITY_CATEGORIES[req.query.category] || null
  const result = await query(
    `SELECT a.id, a.kind, a.group_jid, g.name AS group_name, a.summary, a.created_at
     FROM whatsapp_bot_activity a LEFT JOIN whatsapp_groups g ON g.jid = a.group_jid
     WHERE ($1::text[] IS NULL OR a.kind = ANY($1))
     ORDER BY a.id DESC LIMIT 100`,
    [kinds]
  )
  res.json({ items: result.rows })
})

// DELETE /admin/whatsapp/groups/:jid — take a group he was removed from off
// the list. Its saved chats stay in the Chats tab until deleted there.
router.delete('/whatsapp/groups/:jid', requireRole('superadmin'), async (req, res) => {
  await ensureGroupSettingsColumn()
  const result = await query(`DELETE FROM whatsapp_groups WHERE jid = $1 AND settings->>'left' = 'true' RETURNING jid`, [req.params.jid])
  if (result.rows.length === 0) return res.status(400).json({ error: 'Only groups Bro Paul has been removed from can be taken off the list.' })
  await logAction(req.user.id, 'whatsapp.group_forget', 'whatsapp_group', req.params.jid)
  res.json({ ok: true })
})

// POST /admin/whatsapp/groups/:jid/start  { introduce }
// A new group: Bro Paul starts talking there, introducing himself first if
// asked. An active group: introduce = he introduces himself again now.
router.post('/whatsapp/groups/:jid/start', requireRole('superadmin'), async (req, res) => {
  await Promise.all([ensureGroupSettingsColumn(), ensureChatLogTables()])
  const jid = req.params.jid
  const result = await query(
    `UPDATE whatsapp_groups SET enabled = TRUE, settings = settings || '{"started": true}'::jsonb
     WHERE jid = $1 RETURNING jid, enabled, settings`,
    [jid]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Group not found' })
  if (req.body?.introduce) {
    await query(`INSERT INTO whatsapp_bot_outbox (group_jid, text, kind, created_by) VALUES ($1, '(introduction)', 'intro', $2)`, [jid, req.user.id])
  }
  await logAction(req.user.id, req.body?.introduce ? 'whatsapp.group_introduce' : 'whatsapp.group_start', 'whatsapp_group', jid)
  const row = result.rows[0]
  res.json({ ...row, settings: withGroupDefaults(row.settings) })
})

// ---------- Saved chats (Chats tab) ----------

// GET /admin/whatsapp/chats?type=group|private — one row per conversation.
router.get('/whatsapp/chats', requireRole('superadmin'), async (req, res) => {
  await ensureChatLogTables()
  const type = ['group', 'private'].includes(req.query.type) ? req.query.type : null
  const result = await query(
    `SELECT m.chat_jid, m.chat_type, COALESCE(g.name, last.chat_name, last.sender_name) AS name,
            m.count, last.text AS last_text, last.from_bot AS last_from_bot, last.created_at AS last_at
     FROM (SELECT chat_jid, chat_type, COUNT(*)::int AS count, MAX(id) AS last_id
           FROM whatsapp_messages WHERE ($1::text IS NULL OR chat_type = $1)
           GROUP BY chat_jid, chat_type) m
     JOIN whatsapp_messages last ON last.id = m.last_id
     LEFT JOIN whatsapp_groups g ON g.jid = m.chat_jid
     ORDER BY last.id DESC LIMIT 300`,
    [type]
  )
  res.json({ items: result.rows })
})

// GET /admin/whatsapp/chats/:jid/messages?before=<id> — 100 at a time, oldest first.
router.get('/whatsapp/chats/:jid/messages', requireRole('superadmin'), async (req, res) => {
  await ensureChatLogTables()
  const before = Number(req.query.before) || null
  const result = await query(
    `SELECT id, sender_name, from_bot, kind, text, created_at FROM whatsapp_messages
     WHERE chat_jid = $1 AND ($2::bigint IS NULL OR id < $2)
     ORDER BY id DESC LIMIT 100`,
    [req.params.jid, before]
  )
  res.json({ items: result.rows.reverse(), more: result.rows.length === 100 })
})

// DELETE /admin/whatsapp/chats/:jid — one conversation; /admin/whatsapp/chats — all of them.
router.delete('/whatsapp/chats/:jid', requireRole('superadmin'), async (req, res) => {
  await ensureChatLogTables()
  const result = await query(`DELETE FROM whatsapp_messages WHERE chat_jid = $1`, [req.params.jid])
  await logAction(req.user.id, 'whatsapp.chat_delete', 'whatsapp_chat', req.params.jid)
  res.json({ deleted: result.rowCount })
})

router.delete('/whatsapp/chats', requireRole('superadmin'), async (req, res) => {
  await ensureChatLogTables()
  const result = await query(`DELETE FROM whatsapp_messages`)
  await logAction(req.user.id, 'whatsapp.chat_delete_all', 'whatsapp_chat', 'all')
  res.json({ deleted: result.rowCount })
})

// GET /admin/whatsapp/chat-storage — how full the chat log is.
router.get('/whatsapp/chat-storage', requireRole('superadmin'), async (req, res) => {
  res.json(await chatLogUsage())
})

// GET /admin/whatsapp/chats-export — every saved message, for the zip download.
router.get('/whatsapp/chats-export', requireRole('superadmin'), async (req, res) => {
  await ensureChatLogTables()
  const result = await query(
    `SELECT m.chat_jid, m.chat_type, COALESCE(g.name, m.chat_name) AS chat_name, m.sender_name, m.from_bot, m.kind, m.text, m.created_at
     FROM whatsapp_messages m LEFT JOIN whatsapp_groups g ON g.jid = m.chat_jid
     ORDER BY m.chat_jid, m.id LIMIT 300000`
  )
  await logAction(req.user.id, 'whatsapp.chat_export', 'whatsapp_chat', 'all')
  res.json({ items: result.rows })
})

router.get('/system/errors', requireRole('superadmin'), (req, res) => {
  res.json({ items: getRecentErrors() })
})

export default router
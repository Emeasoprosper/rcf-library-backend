// routes/community.js
import { Router } from 'express'
import { query } from '../db/pool.js'
import { attachUser, requireAuth } from '../middleware/auth.js'

const router = Router()

// GET /community/notifications — used by Home.jsx via communityApi.notifications()
router.get('/notifications', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `SELECT id, type, title, body, link_to, thumbnail_url, resource_id, is_read, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.user.id]
  )
  res.json({ items: result.rows })
})

// PATCH /community/notifications/:id/read
router.patch('/notifications/:id/read', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' })
  res.json({ ok: true })
})

// DELETE /community/notifications/:id
router.delete('/notifications/:id', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' })
  res.json({ ok: true })
})

// GET /downloads
router.get('/downloads', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (r.id)
              r.id, r.title, r.thumbnail_url, r.file_size_bytes, r.file_type,
              d.downloaded_at
       FROM downloads d
       JOIN resources r ON r.id = d.resource_id
       WHERE d.user_id = $1
       ORDER BY r.id, d.downloaded_at DESC
     ) sub
     ORDER BY downloaded_at DESC`,
    [req.user.id]
  )
  res.json({ items: result.rows })
})

// GET /community/reading-history
//
// r.file_type added to the SELECT (was missing). Without it, every row
// coming back had file_type = undefined, so Home.jsx's laneOf(h.file_type)
// could never detect "video" or "audio" — everything silently fell
// through to the "book" bucket, which is why Continue Watching / Continue
// Listening always came back empty and Jump Back In's "78% watched" /
// "% listened" subtitles showed as "undefined%".
router.get('/reading-history', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `SELECT rh.id, rh.resource_id, rh.progress_percent, rh.completed_at, rh.last_accessed_at,
            r.title, r.author, r.thumbnail_url, r.file_type
     FROM reading_history rh
     JOIN resources r ON r.id = rh.resource_id
     WHERE rh.user_id = $1
     ORDER BY rh.last_accessed_at DESC
     LIMIT 20`,
    [req.user.id]
  )
  res.json({ items: result.rows })
})

// GET /community/bookmarks — a user's saved/pinned resources, most
// recently bookmarked first. Backs the "Saved" rail on Home once the
// frontend is wired to call it (see communityApi in services/api.js —
// not added there yet, needs that file to match its existing call
// pattern rather than guessing at it).
router.get('/bookmarks', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `SELECT r.id, r.title, r.author, r.thumbnail_url, r.thumbnail_status, r.file_type,
            b.created_at AS bookmarked_at
     FROM bookmarks b
     JOIN resources r ON r.id = b.resource_id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC
     LIMIT 50`,
    [req.user.id]
  )
  res.json({ items: result.rows })
})

// GET /community/announcements?type=news&page=1&pageSize=10
router.get('/announcements', async (req, res) => {
  const { type = '', page = 1, pageSize = 10 } = req.query
  const limit = Math.min(Number(pageSize) || 10, 50)
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit

  try {
    const result = await query(
      `SELECT id, type, title, message, attachment_url, created_at
       FROM announcements
       WHERE ($1 = '' OR type = $1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [type, limit, offset]
    )
    res.json({ items: result.rows })
  } catch (err) {
    console.error('Failed to fetch announcements:', err)
    res.status(500).json({ error: 'Failed to fetch announcements' })
  }
})

// GET /me/uploads
router.get('/me/uploads', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `SELECT id, title, thumbnail_url, status, rejection_reason, created_at
     FROM resources
     WHERE uploaded_by = $1
     ORDER BY created_at DESC`,
    [req.user.id]
  )
  res.json({ items: result.rows })
})

// DELETE /me/uploads/:id
router.delete('/me/uploads/:id', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `DELETE FROM resources
     WHERE id = $1 AND uploaded_by = $2 AND status != 'approved'
     RETURNING id`,
    [req.params.id, req.user.id]
  )
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Submission not found, or it is already approved and live in the library' })
  }
  res.json({ ok: true })
})

// GET /leaderboard
router.get('/leaderboard', async (req, res) => {
  const result = await query(
    `SELECT u.id, u.name, u.avatar_url, COUNT(r.id) AS uploads_count
     FROM users u
     JOIN resources r ON r.uploaded_by = u.id AND r.status = 'approved'
     GROUP BY u.id
     ORDER BY uploads_count DESC
     LIMIT 10`
  )
  res.json({ items: result.rows })
})

// ---------------------------------------------------------
// MATERIAL REQUESTS
// ---------------------------------------------------------

router.post('/requests', attachUser, requireAuth, async (req, res) => {
  const { title, courseCode, notes, categoryId, details } = req.body

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' })
  }

  const result = await query(
    `INSERT INTO material_requests (user_id, title, course_code, notes, category_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, course_code, notes, category_id, details, status, created_at`,
    [
      req.user.id,
      title.trim(),
      courseCode?.trim() || null,
      notes?.trim() || null,
      categoryId || null,
      details && typeof details === 'object' ? JSON.stringify(details) : '{}',
    ]
  )
  res.status(201).json({ request: result.rows[0] })
})

router.get('/me/requests', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `SELECT mr.id, mr.title, mr.course_code, mr.notes, mr.status, mr.created_at,
            mr.category_id, mr.details, c.name AS category,
            mr.fulfilled_resource_id, r.title AS fulfilled_resource_title
     FROM material_requests mr
     LEFT JOIN resources r ON r.id = mr.fulfilled_resource_id
     LEFT JOIN categories c ON c.id = mr.category_id
     WHERE mr.user_id = $1
     ORDER BY mr.created_at DESC`,
    [req.user.id]
  )
  res.json({ items: result.rows })
})

// ---------------------------------------------------------
// MATERIAL SUGGESTIONS
// ---------------------------------------------------------

router.post('/suggestions', attachUser, requireAuth, async (req, res) => {
  const { title, author, publisher, categoryId, departmentId, courseCode, reason } = req.body

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' })
  }

  const result = await query(
    `INSERT INTO material_suggestions
       (user_id, title, author, publisher, category_id, department_id, course_code, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      req.user.id,
      title.trim(),
      author?.trim() || null,
      publisher?.trim() || null,
      categoryId || null,
      departmentId || null,
      courseCode?.trim() || null,
      reason?.trim() || null,
    ]
  )
  res.status(201).json({ id: result.rows[0].id })
})

// GET /suggestions/trending — now also returns, per suggestion:
//   - reply_count (from discussion_threads, 0 if no thread yet)
//   - reaction_counts: { like: 2, helpful: 1, useful: 0 }
//   - my_reaction: 'like' | 'helpful' | 'useful' | null
router.get('/suggestions/trending', attachUser, async (req, res) => {
  const result = await query(
    `SELECT ms.id, ms.title, ms.author, ms.publisher, ms.course_code, ms.reason,
            ms.votes_count, ms.status, ms.created_at,
            c.name AS category, d.name AS department,
            u.id AS user_id, u.name AS suggested_by, u.avatar_url AS suggested_by_avatar,
            EXISTS (
              SELECT 1 FROM suggestion_votes sv
              WHERE sv.suggestion_id = ms.id AND sv.user_id = $1
            ) AS my_vote,
            COALESCE(dt.reply_count, 0) AS reply_count,
            COALESCE(rc.counts, '{}'::json) AS reaction_counts,
            ur.kind AS my_reaction
     FROM material_suggestions ms
     LEFT JOIN categories c ON c.id = ms.category_id
     LEFT JOIN departments d ON d.id = ms.department_id
     LEFT JOIN users u ON u.id = ms.user_id
     LEFT JOIN discussion_threads dt ON dt.suggestion_id = ms.id
     LEFT JOIN LATERAL (
       SELECT json_object_agg(kind, cnt) AS counts
       FROM (
         SELECT kind, COUNT(*) AS cnt
         FROM reactions
         WHERE target_type = 'suggestion' AND target_id = ms.id
         GROUP BY kind
       ) sub
     ) rc ON true
     LEFT JOIN reactions ur ON ur.target_type = 'suggestion' AND ur.target_id = ms.id AND ur.user_id = $1
     ORDER BY ms.votes_count DESC, ms.created_at DESC
     LIMIT 30`,
    [req.user?.id || null]
  )
  res.json({ items: result.rows })
})

router.post('/suggestions/:id/vote', attachUser, requireAuth, async (req, res) => {
  const existing = await query(
    `SELECT 1 FROM suggestion_votes WHERE suggestion_id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  )

  if (existing.rows.length > 0) {
    await query(
      `DELETE FROM suggestion_votes WHERE suggestion_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    )
    await query(
      `UPDATE material_suggestions SET votes_count = GREATEST(votes_count - 1, 0) WHERE id = $1`,
      [req.params.id]
    )
    return res.json({ ok: true, voted: false })
  }

  await query(
    `INSERT INTO suggestion_votes (suggestion_id, user_id) VALUES ($1, $2)`,
    [req.params.id, req.user.id]
  )
  await query(
    `UPDATE material_suggestions SET votes_count = votes_count + 1 WHERE id = $1`,
    [req.params.id]
  )
  res.json({ ok: true, voted: true })
})

// ---------------------------------------------------------
// DISCUSSION REPLIES & REACTIONS
// Backed by discussion_threads / discussion_replies / reactions
// (see db/add-community-features.js). One thread per suggestion,
// created lazily the first time it's needed.
// ---------------------------------------------------------

const REACTION_KINDS = new Set(['like', 'helpful', 'useful'])

async function ensureThread(suggestionId) {
  const existing = await query(
    `SELECT id FROM discussion_threads WHERE suggestion_id = $1`,
    [suggestionId]
  )
  if (existing.rows.length > 0) return existing.rows[0].id

  const inserted = await query(
    `INSERT INTO discussion_threads (suggestion_id) VALUES ($1)
     ON CONFLICT (suggestion_id) DO NOTHING
     RETURNING id`,
    [suggestionId]
  )
  if (inserted.rows.length > 0) return inserted.rows[0].id

  // Lost a race with a concurrent request that created it first.
  const retry = await query(
    `SELECT id FROM discussion_threads WHERE suggestion_id = $1`,
    [suggestionId]
  )
  return retry.rows[0].id
}

// GET /suggestions/:id/replies
router.get('/suggestions/:id/replies', attachUser, async (req, res) => {
  const threadResult = await query(
    `SELECT id, is_locked FROM discussion_threads WHERE suggestion_id = $1`,
    [req.params.id]
  )
  if (threadResult.rows.length === 0) {
    return res.json({ items: [], isLocked: false })
  }

  const { id: threadId, is_locked: isLocked } = threadResult.rows[0]

  const result = await query(
    `SELECT dr.id, dr.parent_reply_id, dr.body, dr.created_at, dr.is_deleted,
            u.id AS user_id, u.name AS user_name, u.avatar_url AS user_avatar,
            (u.role IN ('admin','superadmin')) AS is_admin,
            COALESCE(rc.counts, '{}'::json) AS reaction_counts,
            ur.kind AS my_reaction
     FROM discussion_replies dr
     JOIN users u ON u.id = dr.user_id
     LEFT JOIN LATERAL (
       SELECT json_object_agg(kind, cnt) AS counts
       FROM (
         SELECT kind, COUNT(*) AS cnt
         FROM reactions
         WHERE target_type = 'reply' AND target_id = dr.id
         GROUP BY kind
       ) sub
     ) rc ON true
     LEFT JOIN reactions ur ON ur.target_type = 'reply' AND ur.target_id = dr.id AND ur.user_id = $2
     WHERE dr.thread_id = $1
     ORDER BY dr.created_at ASC`,
    [threadId, req.user?.id || null]
  )
  res.json({ items: result.rows, isLocked })
})

// POST /suggestions/:id/replies  { body, parentReplyId? }
router.post('/suggestions/:id/replies', attachUser, requireAuth, async (req, res) => {
  const { body, parentReplyId } = req.body
  if (!body || !body.trim()) return res.status(400).json({ error: 'Reply cannot be empty' })
  if (body.trim().length > 2000) return res.status(400).json({ error: 'Reply is too long' })

  const suggestionCheck = await query(`SELECT id FROM material_suggestions WHERE id = $1`, [req.params.id])
  if (suggestionCheck.rows.length === 0) return res.status(404).json({ error: 'Suggestion not found' })

  const threadId = await ensureThread(req.params.id)

  const threadState = await query(`SELECT is_locked FROM discussion_threads WHERE id = $1`, [threadId])
  if (threadState.rows[0]?.is_locked) return res.status(403).json({ error: 'This discussion is locked' })

  if (parentReplyId) {
    const parentCheck = await query(
      `SELECT id FROM discussion_replies WHERE id = $1 AND thread_id = $2`,
      [parentReplyId, threadId]
    )
    if (parentCheck.rows.length === 0) return res.status(400).json({ error: 'Invalid parent reply' })
  }

  const inserted = await query(
    `INSERT INTO discussion_replies (thread_id, parent_reply_id, user_id, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, thread_id, parent_reply_id, body, created_at`,
    [threadId, parentReplyId || null, req.user.id, body.trim()]
  )
  await query(`UPDATE discussion_threads SET reply_count = reply_count + 1 WHERE id = $1`, [threadId])

  res.status(201).json({
    reply: {
      ...inserted.rows[0],
      is_deleted: false,
      user_id: req.user.id,
      user_name: req.user.name,
      user_avatar: req.user.avatarUrl || null,
      is_admin: req.user.role === 'admin' || req.user.role === 'superadmin',
      reaction_counts: {},
      my_reaction: null,
    },
  })
})

// POST /suggestions/:id/react  { kind }
router.post('/suggestions/:id/react', attachUser, requireAuth, async (req, res) => {
  const { kind } = req.body
  if (!REACTION_KINDS.has(kind)) return res.status(400).json({ error: 'Invalid reaction kind' })

  await query(
    `INSERT INTO reactions (target_type, target_id, user_id, kind)
     VALUES ('suggestion', $1, $2, $3)
     ON CONFLICT (target_type, target_id, user_id) DO UPDATE SET kind = EXCLUDED.kind`,
    [req.params.id, req.user.id, kind]
  )
  res.json({ ok: true })
})

// DELETE /suggestions/:id/react
router.delete('/suggestions/:id/react', attachUser, requireAuth, async (req, res) => {
  await query(
    `DELETE FROM reactions WHERE target_type = 'suggestion' AND target_id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  )
  res.json({ ok: true })
})

// POST /replies/:id/react  { kind }
router.post('/replies/:id/react', attachUser, requireAuth, async (req, res) => {
  const { kind } = req.body
  if (!REACTION_KINDS.has(kind)) return res.status(400).json({ error: 'Invalid reaction kind' })

  const replyCheck = await query(`SELECT id FROM discussion_replies WHERE id = $1`, [req.params.id])
  if (replyCheck.rows.length === 0) return res.status(404).json({ error: 'Reply not found' })

  await query(
    `INSERT INTO reactions (target_type, target_id, user_id, kind)
     VALUES ('reply', $1, $2, $3)
     ON CONFLICT (target_type, target_id, user_id) DO UPDATE SET kind = EXCLUDED.kind`,
    [req.params.id, req.user.id, kind]
  )
  res.json({ ok: true })
})

// DELETE /replies/:id/react
router.delete('/replies/:id/react', attachUser, requireAuth, async (req, res) => {
  await query(
    `DELETE FROM reactions WHERE target_type = 'reply' AND target_id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  )
  res.json({ ok: true })
})

// DELETE /replies/:id — soft delete, own reply only ("[deleted]" stays
// visible so the thread doesn't have orphaned child replies pointing at
// a hole, matching how most real discussion UIs handle this).
router.delete('/replies/:id', attachUser, requireAuth, async (req, res) => {
  const result = await query(
    `UPDATE discussion_replies SET body = '[deleted]', is_deleted = true
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Reply not found' })
  res.json({ ok: true })
})

export default router
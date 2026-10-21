// rcf-library-backend/src/routes/studyTools.js
import { Router } from 'express'
import { query, pool } from '../db/pool.js'
import { attachUser, requireAuth } from '../middleware/auth.js'
import { generateQuestions, MODE_DEFAULTS } from '../services/questionGenerator.js'

const router = Router()
router.use(attachUser, requireAuth)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAILY_GENERATION_LIMIT = 8
const MAX_NOTES_PER_USER = 500

function toInt(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(Math.max(Math.round(n), min), max)
}

// ---------- Saved material ----------

router.get('/saved', async (req, res) => {
  const result = await query(
    `SELECT r.id, r.title, r.author, r.course_code, r.thumbnail_url, r.file_type, r.page_count,
            rt.slug AS type, rt.label AS type_label,
            COALESCE(t.status, 'none') AS text_status,
            b.created_at AS saved_at
     FROM bookmarks b
     JOIN resources r ON r.id = b.resource_id AND r.status = 'approved'
     JOIN resource_types rt ON rt.id = r.resource_type_id
     LEFT JOIN resource_text t ON t.resource_id = r.id
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC
     LIMIT 200`,
    [req.user.id]
  )
  res.json({ items: result.rows })
})

// ---------- Notes ----------

router.get('/notes', async (req, res) => {
  const { resourceId } = req.query
  if (resourceId && !UUID_RE.test(String(resourceId))) return res.status(400).json({ error: 'Invalid resource' })
  const result = await query(
    `SELECT n.id, n.title, n.body, n.resource_id, n.updated_at, r.title AS resource_title
     FROM study_notes n
     LEFT JOIN resources r ON r.id = n.resource_id
     WHERE n.user_id = $1 AND ($2::uuid IS NULL OR n.resource_id = $2::uuid)
     ORDER BY n.updated_at DESC
     LIMIT 200`,
    [req.user.id, resourceId || null]
  )
  res.json({ items: result.rows })
})

router.post('/notes', async (req, res) => {
  const { title, body = '', resourceId = null } = req.body || {}
  const cleanTitle = String(title || '').trim()
  if (!cleanTitle || cleanTitle.length > 120) return res.status(400).json({ error: 'Title is required (max 120 characters)' })
  const cleanBody = String(body).slice(0, 20000)
  if (resourceId !== null && !UUID_RE.test(String(resourceId))) return res.status(400).json({ error: 'Invalid resource' })

  const count = await query(`SELECT COUNT(*)::int AS n FROM study_notes WHERE user_id = $1`, [req.user.id])
  if (count.rows[0].n >= MAX_NOTES_PER_USER) return res.status(400).json({ error: 'You have too many notes. Delete some first.' })

  const inserted = await query(
    `INSERT INTO study_notes (user_id, resource_id, title, body) VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.user.id, resourceId, cleanTitle, cleanBody]
  )
  res.status(201).json({ id: inserted.rows[0].id })
})

router.patch('/notes/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid note' })
  const cleanTitle = String(req.body?.title || '').trim()
  if (!cleanTitle || cleanTitle.length > 120) return res.status(400).json({ error: 'Title is required (max 120 characters)' })
  const cleanBody = String(req.body?.body ?? '').slice(0, 20000)
  const result = await query(
    `UPDATE study_notes SET title = $3, body = $4, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.id, cleanTitle, cleanBody]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Note not found' })
  res.json({ ok: true })
})

router.delete('/notes/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid note' })
  await query(`DELETE FROM study_notes WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id])
  res.json({ ok: true })
})

// ---------- Question sets ----------

router.get('/question-sets', async (req, res) => {
  const result = await query(
    `SELECT s.id, s.title, s.mode, s.difficulty, s.time_limit_min, s.created_at,
            r.title AS resource_title,
            (SELECT COUNT(*)::int FROM questions q WHERE q.set_id = s.id) AS question_count,
            (SELECT a.score FROM question_attempts a WHERE a.set_id = s.id AND a.user_id = $1
               ORDER BY a.submitted_at DESC LIMIT 1) AS last_score,
            (SELECT a.total FROM question_attempts a WHERE a.set_id = s.id AND a.user_id = $1
               ORDER BY a.submitted_at DESC LIMIT 1) AS last_total
     FROM question_sets s
     LEFT JOIN resources r ON r.id = s.resource_id
     WHERE s.user_id = $1
     ORDER BY s.created_at DESC
     LIMIT 50`,
    [req.user.id]
  )
  res.json({ items: result.rows })
})

router.post('/question-sets/generate', async (req, res) => {
  const { resourceId, mode = 'practice', difficulty = 'medium', count, pageFrom, pageTo } = req.body || {}
  if (!UUID_RE.test(String(resourceId || ''))) return res.status(400).json({ error: 'Choose a resource' })
  const defaults = MODE_DEFAULTS[mode]
  if (!defaults) return res.status(400).json({ error: 'Invalid mode' })
  if (!['easy', 'medium', 'hard'].includes(difficulty)) return res.status(400).json({ error: 'Invalid difficulty' })

  const wanted = toInt(count ?? defaults.count, 5, 30)
  const from = pageFrom ? toInt(pageFrom, 1, 100000) : null
  const to = pageTo ? toInt(pageTo, 1, 100000) : null
  if (from && to && to < from) return res.status(400).json({ error: 'The end page must be after the start page' })

  const used = await query(
    `SELECT COUNT(*)::int AS n FROM question_sets
     WHERE user_id = $1
       AND (created_at AT TIME ZONE 'Africa/Lagos')::date = (now() AT TIME ZONE 'Africa/Lagos')::date`,
    [req.user.id]
  )
  if (used.rows[0].n >= DAILY_GENERATION_LIMIT) {
    return res.status(429).json({ error: `You can generate ${DAILY_GENERATION_LIMIT} question sets per day. Try again tomorrow.` })
  }

  const generated = await generateQuestions({ resourceId, mode, difficulty, count: wanted, pageFrom: from, pageTo: to })
  const timeLimit = defaults.minutesPerQuestion
    ? Math.ceil(generated.questions.length * defaults.minutesPerQuestion)
    : null
  const title = `${defaults.label}: ${generated.resourceTitle}`.slice(0, 120)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const set = await client.query(
      `INSERT INTO question_sets (user_id, resource_id, title, mode, difficulty, page_from, page_to, time_limit_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.user.id, resourceId, title, mode, difficulty, from, to, timeLimit]
    )
    const setId = set.rows[0].id
    for (let i = 0; i < generated.questions.length; i += 1) {
      const q = generated.questions[i]
      await client.query(
        `INSERT INTO questions (set_id, position, kind, prompt, options, answer, explanation)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [setId, i + 1, q.kind, q.prompt, q.options ? JSON.stringify(q.options) : null, q.answer, q.explanation]
      )
    }
    await client.query('COMMIT')
    res.status(201).json({ id: setId, usedStyleReference: generated.usedStyleReference })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
})

// Answers and explanations are NOT sent here — only after submitting.
router.get('/question-sets/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid set' })
  const set = await query(
    `SELECT s.id, s.title, s.mode, s.difficulty, s.time_limit_min, s.page_from, s.page_to,
            r.title AS resource_title
     FROM question_sets s LEFT JOIN resources r ON r.id = s.resource_id
     WHERE s.id = $1 AND s.user_id = $2`,
    [req.params.id, req.user.id]
  )
  if (set.rows.length === 0) return res.status(404).json({ error: 'Question set not found' })
  const questions = await query(
    `SELECT id, position, kind, prompt, options FROM questions WHERE set_id = $1 ORDER BY position`,
    [req.params.id]
  )
  res.json({ set: set.rows[0], questions: questions.rows })
})

// POST /question-sets/:id/attempt { answers: { [questionId]: "B" | "typed text" }, durationSeconds }
// Multiple choice is scored. Short/theory answers are stored and shown
// with the model answer, but not scored.
router.post('/question-sets/:id/attempt', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid set' })
  const owned = await query(`SELECT 1 FROM question_sets WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id])
  if (owned.rows.length === 0) return res.status(404).json({ error: 'Question set not found' })

  const questions = await query(
    `SELECT id, position, kind, prompt, options, answer, explanation
     FROM questions WHERE set_id = $1 ORDER BY position`,
    [req.params.id]
  )
  const answers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {}
  const duration = req.body?.durationSeconds == null ? null : toInt(req.body.durationSeconds, 0, 86400)

  let score = 0
  let total = 0
  const stored = {}
  const results = questions.rows.map((q) => {
    const given = answers[q.id] == null ? '' : String(answers[q.id]).trim().slice(0, 2000)
    if (given) stored[q.id] = given
    let correct = null
    if (q.kind === 'mcq') {
      total += 1
      correct = given.toUpperCase() === q.answer
      if (correct) score += 1
    }
    return {
      id: q.id, position: q.position, kind: q.kind, prompt: q.prompt, options: q.options,
      answer: q.answer, explanation: q.explanation, yourAnswer: given || null, correct,
    }
  })

  const attempt = await query(
    `INSERT INTO question_attempts (set_id, user_id, score, total, duration_seconds, answers)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.params.id, req.user.id, score, total, duration, JSON.stringify(stored)]
  )
  res.json({ attemptId: attempt.rows[0].id, score, total, results })
})

router.delete('/question-sets/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid set' })
  await query(`DELETE FROM question_sets WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id])
  res.json({ ok: true })
})

export default router
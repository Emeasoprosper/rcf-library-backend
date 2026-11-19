// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/aiLibrary.js
// Books the library gets without a person uploading them:
//   - AI lecture notes: someone asks (app or WhatsApp) for lecture notes the
//     library doesn't have. A job is queued, noteGenerator.js writes them,
//     notesPdf.js lays them out with the RCF logo (author "RCF MOUAU"), and
//     they're published, fulfilling the request(s) and messaging whoever asked.
//   - Bro Paul uploads: files people send him on WhatsApp for the library
//     (past questions, notes…), added on their behalf.
// Both are marked in resources.ai_origin ('generated' | 'bot_upload') so the
// admin app's AI Library page can list them, and both go live straight away
// unless the matching switch in the bot settings says otherwise.
import crypto from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { query } from '../db/pool.js'
import { uploadToStorage } from './storage.js'
import { resolveUploadCategory } from '../config/driveFolders.js'
import { queuePreviewGeneration } from './previewQueue.js'
import { lookupCourse, analyzeResourceFile } from './aiAnalysis.js'
import { normalizeCourseCode } from '../utils/courseCode.js'
import { sendPush } from './pushService.js'
import { getBotSettings } from './botSettings.js'
import {
  TEACHER,
  chapterPrompt,
  cleanText,
  draftProgress,
  generateCourseNotes,
  notesProvider,
  parsePlan,
  planPrompt,
  revisionPrompt,
} from './noteGenerator.js'
import { renderNotesPdf } from './notesPdf.js'
import { fingerprint, fingerprintAll, findDuplicate } from './duplicates.js'
import { isWhatsappRequest, queueReadyDm, SITE_URL } from './whatsappRequests.js'
import { sendPushToUser } from '../routes/community.js'

export const AI_AUTHOR = 'RCF MOUAU'
export const LECTURE_NOTES_RE = /\b(lecture\s*notes?|notes?|handouts?|course\s*materials?)\b/i
export const PAST_QUESTION_RE = /\b(past\s*questions?|p\.?\s?q'?s?|exam\s*questions?|test\s*questions?)\b/i

// ---------- tables ----------
let ready = null
export function ensureAiTables() {
  ready ||= query(`
    ALTER TABLE resources ADD COLUMN IF NOT EXISTS ai_origin TEXT;
    ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_sha256 TEXT;
    CREATE INDEX IF NOT EXISTS idx_resources_ai_origin ON resources (ai_origin) WHERE ai_origin IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_resources_sha256 ON resources (file_sha256) WHERE file_sha256 IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind          TEXT NOT NULL DEFAULT 'lecture_notes',
      course_key    TEXT,
      course_code   TEXT,
      title         TEXT,
      level         TEXT,
      status        TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
      progress      INT NOT NULL DEFAULT 0,
      step          TEXT,
      request_ids   UUID[] NOT NULL DEFAULT '{}',
      requested_by  TEXT,                             -- who started it, for the admin list
      resource_id   UUID REFERENCES resources(id) ON DELETE SET NULL,
      provider      TEXT,
      error         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at    TIMESTAMPTZ,
      finished_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON ai_jobs (status, created_at);
    -- draft: the plan + chapters written so far (resume after a pause)
    -- retry_after: waiting for the free AI limit to reset until then
    ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS draft JSONB;
    ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;
    -- claimed_by 'kaggle' = being written by your own AI on Kaggle;
    -- worker_seen = its last sign of life (a silent worker's job is taken back)
    ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS claimed_by TEXT;
    ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS worker_seen TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS ai_worker_status (
      id INT PRIMARY KEY DEFAULT 1,
      last_seen TIMESTAMPTZ,
      model TEXT,
      jobs_done INT NOT NULL DEFAULT 0
    );
  `).catch((err) => {
    ready = null
    throw err
  })
  return ready
}

// The account AI-made and Bro-Paul-uploaded books are filed under.
let systemUserId = null
export async function getSystemUserId() {
  if (systemUserId) return systemUserId
  const result = await query(
    `INSERT INTO users (google_id, email, name, role)
     VALUES ('system:rcf-library-ai', 'library-ai@system.rcf-mouau.local', 'RCF Library AI', 'student')
     ON CONFLICT (google_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
  )
  systemUserId = result.rows[0].id
  return systemUserId
}

// ---------- titles ----------
const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

// No two books share an exact title AND author. The same title by a
// different author is fine; the same author again becomes "… II", "… III".
export async function uniqueTitle(title, author) {
  const base = String(title || 'Untitled').replace(/\s+/g, ' ').trim()
  const result = await query(
    `SELECT lower(title) AS t FROM resources
     WHERE status <> 'rejected'
       AND lower(coalesce(author, '')) = lower($1)
       AND left(lower(title), length($2)) = lower($2)`,
    [author || '', base]
  )
  const taken = new Set(result.rows.map((r) => r.t))
  if (!taken.has(base.toLowerCase())) return base
  for (const numeral of ROMAN) {
    const candidate = `${base} ${numeral}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base} (${new Date().toISOString().slice(0, 10)})`
}

const courseKey = (code) => (normalizeCourseCode(code) || '').replace(/\s+/g, '')

async function typeId(slug) {
  const r = await query('SELECT id FROM resource_types WHERE slug = $1', [slug])
  if (r.rows.length) return r.rows[0].id
  return (await query(`SELECT id FROM resource_types WHERE slug = 'other'`)).rows[0]?.id
}

// resourceId links the notification to its book, so the app shows that
// book's cover (looked up when the list is read, so it's always current).
async function notifyAdmins({ title, body, url, type, resourceId = null, thumbnailUrl = null }) {
  const admins = await query(`SELECT id FROM users WHERE role IN ('admin', 'superadmin') AND is_suspended = false`)
  const ids = admins.rows.map((r) => r.id)
  if (!ids.length) return
  await query(
    `INSERT INTO notifications (user_id, type, title, body, link_to, resource_id, thumbnail_url)
     SELECT unnest($1::uuid[]), $2, $3, $4, $5, $6, $7`,
    [ids, type, title, body, url, resourceId, thumbnailUrl]
  )
  await sendPush({ category: 'updates', userIds: ids, title, body, url, tag: `${type}-${Date.now()}` }).catch(() => {})
}

// Marks requests fulfilled with this resource and tells each person: a
// notification + push in the app, or a DM from Bro Paul on WhatsApp.
export async function fulfilRequests(requestIds, resource, { aiWritten = false } = {}) {
  let count = 0
  const systemId = await getSystemUserId()
  for (const id of [...new Set(requestIds)]) {
    const result = await query(
      `UPDATE material_requests SET status = 'fulfilled', resolved_at = now(), fulfilled_resource_id = $2
       WHERE id = $1 AND status = 'open' RETURNING user_id, title, details`,
      [id, resource.id]
    )
    const row = result.rows[0]
    if (!row) continue
    count += 1
    if (row.user_id) {
      const body = `"${resource.title}" is now in the library. Tap to open it.`
      await query(
        `INSERT INTO notifications (user_id, type, title, body, link_to, thumbnail_url, resource_id)
         VALUES ($1, 'request_resolved', 'Your request was fulfilled!', $2, $3, $4, $5)`,
        [row.user_id, body, `/library/${resource.id}`, resource.thumbnail_url || null, resource.id]
      ).catch(() => {})
      sendPushToUser(row.user_id, { title: aiWritten ? '✍️ Your lecture notes are ready!' : 'Your request was fulfilled!', body, url: `/library/${resource.id}` }).catch(() => {})
    } else if (isWhatsappRequest(row.details)) {
      // Combined with any other books ready for them, guide once a day.
      await queueReadyDm(
        row.details.whatsappId,
        { whatsappName: row.details.whatsappName, requestTitle: row.title, resourceId: resource.id, resourceTitle: resource.title, aiWritten },
        systemId
      ).catch((err) => console.error('Queue ready DM failed:', err.message))
    }
  }
  return count
}

// ---------- lecture notes ----------
export function looksLikeLectureNotes(text) {
  return LECTURE_NOTES_RE.test(String(text || '')) && !PAST_QUESTION_RE.test(String(text || ''))
}

async function existingNotes(code, title) {
  const key = courseKey(code)
  const result = await query(
    `SELECT r.id, r.title FROM resources r JOIN resource_types t ON t.id = r.resource_type_id
     WHERE r.status = 'approved' AND t.slug = 'lecture_notes'
       AND (($1 <> '' AND upper(replace(coalesce(r.course_code, ''), ' ', '')) = $1)
            OR ($1 = '' AND lower(r.title) LIKE '%' || lower($2) || '%'))
     ORDER BY (r.ai_origin = 'generated') DESC NULLS LAST, r.created_at DESC LIMIT 1`,
    [key, String(title || '').slice(0, 80)]
  )
  if (result.rows[0] || key || !title) return result.rows[0] || null
  // No code: compare titles loosely ("Intro to Accounting" = "Introduction to Accounting").
  const want = titleKey(title)
  if (!want) return null
  const notes = await query(
    `SELECT r.id, r.title FROM resources r JOIN resource_types t ON t.id = r.resource_type_id
     WHERE r.status = 'approved' AND t.slug = 'lecture_notes'
     ORDER BY (r.ai_origin = 'generated') DESC NULLS LAST, r.created_at DESC LIMIT 2000`
  )
  return notes.rows.find((r) => titleKey(r.title) === want) || null
}

// The same course written differently gets the same key: lower case, common
// short forms spelled out, little words and "lecture notes" dropped.
const SHORT_FORMS = {
  intro: 'introduction', introd: 'introduction', princ: 'principles', principle: 'principles', prin: 'principles',
  mgt: 'management', mgmt: 'management', mgmnt: 'management', acct: 'accounting', acc: 'accounting', accts: 'accounting',
  econs: 'economics', eco: 'economics', bus: 'business', biz: 'business', maths: 'mathematics', math: 'mathematics',
  stats: 'statistics', stat: 'statistics', fin: 'finance', mkt: 'marketing', mktg: 'marketing', ent: 'entrepreneurship',
  comm: 'communication', comp: 'computer', sci: 'science', tech: 'technology', govt: 'government', hist: 'history',
  gen: 'general', elem: 'elements', fund: 'fundamentals', fundamental: 'fundamentals', '&': 'and',
}
const LITTLE_WORDS = new Set(['of', 'to', 'the', 'and', 'in', 'a', 'an', 'for', 'on', 'lecture', 'lectures', 'note', 'notes', 'course', 'material', 'materials'])
export function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\b[a-z]{3}\s?-?\d{3}\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SHORT_FORMS[w] || w)
    .filter((w) => !LITTLE_WORDS.has(w))
    .map((w) => (w.length > 4 ? w.replace(/s$/, '') : w)) // "principles" = "principle"
    .join(' ')
}

// A request with no course code: if the course list has exactly one course
// with this title, that's its code.
async function codeFromTitle(title) {
  const want = titleKey(title)
  if (!want || want.length < 4) return ''
  const result = await query(`SELECT code, title FROM courses WHERE title IS NOT NULL`).catch(() => ({ rows: [] }))
  const hits = [...new Set(result.rows.filter((c) => titleKey(c.title) === want).map((c) => c.code))]
  return hits.length === 1 ? hits[0] : ''
}

// Queues notes for a course (or joins an identical job already queued).
// Returns { status: 'exists' | 'queued' | 'disabled' | 'unavailable', resourceId?, jobId? }.
export async function requestLectureNotes({ courseCode, title, level, requestIds = [], requestedBy = '', force = false }) {
  await ensureAiTables()
  const settings = await getBotSettings()
  if (!force && !settings.aiLectureNotes) return { status: 'disabled' }
  if (!notesProvider()) return { status: 'unavailable' }

  let code = normalizeCourseCode(courseCode)
  let cleanTitle = String(title || '')
    .replace(LECTURE_NOTES_RE, '')
    // "ELEMENTS OF GOVERNMENT UNIT (2)" / "UNIT(3)" / "3 units": not part of the title
    .replace(/\(?\b\d+\s*units?\b\)?|\bunits?\s*\(?\s*\d+\s*\)?/gi, ' ')
    // the course code itself, when it's in the title too
    .replace(/\b[A-Za-z]{3}\s?-?\d{3}\b/g, ' ')
    .replace(/\b(please|pls|i need|need)\b/gi, ' ')
    .replace(/[\s,;:–-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // ALL CAPS course lists read better in title case.
  if (cleanTitle && cleanTitle === cleanTitle.toUpperCase()) {
    cleanTitle = cleanTitle.toLowerCase().replace(/\b([a-z])([a-z]*)/g, (w, a, b) =>
      /^(of|and|to|in|for|the|on|a|an)$/.test(w) ? w : a.toUpperCase() + b
    )
    cleanTitle = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1)
  }
  if (!code && cleanTitle.length < 3) return { status: 'unavailable' }
  if (!code) code = normalizeCourseCode(await codeFromTitle(cleanTitle)) || code

  if (!force) {
    const found = await existingNotes(code, cleanTitle)
    if (found) {
      if (requestIds.length) await fulfilRequests(requestIds, found)
      return { status: 'exists', resourceId: found.id, title: found.title }
    }
  }

  const key = code ? courseKey(code) : `t:${titleKey(cleanTitle) || cleanTitle.toLowerCase()}`
  // Two people asking for the same course at the same moment: the second
  // waits for the first to finish queuing, then joins that same job.
  return withCourseLock(key, () => queueNotesJob({ key, code, cleanTitle, level, requestIds, requestedBy }))
}

const courseLocks = new Map()
function withCourseLock(key, fn) {
  const prev = courseLocks.get(key) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  courseLocks.set(key, tail)
  tail.then(() => courseLocks.get(key) === tail && courseLocks.delete(key))
  return run
}

async function queueNotesJob({ key, code, cleanTitle, level, requestIds, requestedBy }) {
  const active = await query(
    `UPDATE ai_jobs SET request_ids = (SELECT array_agg(DISTINCT x) FROM unnest(request_ids || $2::uuid[]) x)
     WHERE kind = 'lecture_notes' AND course_key = $1 AND status IN ('queued', 'running')
     RETURNING id`,
    [key, requestIds]
  )
  if (active.rows.length) return { status: 'queued', jobId: active.rows[0].id }

  // A failed job for this course that already has work saved: carry on from
  // it (just publishing, if it's fully written) instead of writing it again.
  const resumable = await query(
    `UPDATE ai_jobs SET status = 'queued', error = NULL, retry_after = NULL, claimed_by = NULL, finished_at = NULL,
            step = 'Continuing from the saved work',
            request_ids = (SELECT array_agg(DISTINCT x) FROM unnest(request_ids || $2::uuid[]) x)
     WHERE id = (SELECT id FROM ai_jobs WHERE kind = 'lecture_notes' AND course_key = $1 AND status = 'failed' AND draft ? 'plan'
                 ORDER BY created_at DESC LIMIT 1)
     RETURNING id`,
    [key, requestIds]
  )
  if (resumable.rows.length) {
    kickWorker()
    return { status: 'queued', jobId: resumable.rows[0].id }
  }

  const inserted = await query(
    `INSERT INTO ai_jobs (kind, course_key, course_code, title, level, request_ids, requested_by, provider)
     VALUES ('lecture_notes', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [key, code, cleanTitle || null, level || null, requestIds, requestedBy || null, notesProvider()?.name || null]
  )
  kickWorker()
  return { status: 'queued', jobId: inserted.rows[0].id }
}

async function publishNotes(job, notes, pdf) {
  const settings = await getBotSettings()
  const course = await lookupCourse(notes.courseCode || job.course_code)
  const baseTitle = `${notes.courseCode ? `${notes.courseCode} – ` : ''}${notes.courseTitle} Lecture Notes`
  const title = await uniqueTitle(baseTitle, AI_AUTHOR)
  const fileName = `${title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 90)}.pdf`
  const file = { originalname: fileName, mimetype: 'application/pdf', buffer: pdf, size: pdf.length }
  const stored = await uploadToStorage(file, resolveUploadCategory({ mimetype: 'application/pdf', resourceTypeSlug: 'lecture_notes' }))
  const description =
    `${notes.description ? `${notes.description} ` : ''}Comprehensive lecture notes by ${AI_AUTHOR}: a ${notes.chapters.length}-week scheme of work, ` +
    `clear explanations, worked examples, practice questions with answers, and a revision chapter. Prepared with AI assistance; read alongside your lecturer's course outline.`
  const result = await query(
    `INSERT INTO resources (
       title, author, description, course_code, department_id, level, resource_type_id,
       storage_provider, file_id, file_url, file_name, file_type, file_size_bytes,
       uploaded_by, is_anonymous, thumbnail_status, status, reviewed_at, ai_origin, file_sha256
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'application/pdf',$12,$13,false,'pending',$14::resource_status,
               CASE WHEN $14::text = 'approved' THEN now() END,'generated',$15)
     RETURNING id, title, thumbnail_url`,
    [
      title, AI_AUTHOR, description, course.code || notes.courseCode || null, course.departmentId || null,
      course.level || notes.level || null, await typeId('lecture_notes'),
      stored.provider, stored.fileId, stored.fileUrl, fileName, pdf.length,
      await getSystemUserId(), settings.aiNotesAutoPublish ? 'approved' : 'pending',
      crypto.createHash('sha256').update(pdf).digest('hex'),
    ]
  )
  const resource = result.rows[0]
  try {
    // Page 1 is the branded cover, so it becomes the thumbnail.
    queuePreviewGeneration(resource.id, stored, 'application/pdf', pdf, null)
  } catch (err) {
    console.error('Preview queue failed for AI notes:', err.message)
  }
  return { resource, published: settings.aiNotesAutoPublish }
}

// "ACC211 FINANCIAL ACCOUNTING I UNIT (3)" -> "Financial Accounting I".
export function tidyCourseTitle(raw) {
  let t = String(raw || '')
    .replace(/\(?\b\d+\s*units?\b\)?|\bunits?\s*\(?\s*\d+\s*\)?/gi, ' ')
    .replace(/\b[A-Za-z]{3}\s?-?\d{3}\b/g, ' ')
    .replace(/\blecture\s*notes?\b/gi, ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/[\s(]*\bunits?\b[\s)]*$/i, ' ') // a bare "Unit" left at the end
    .replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t && t === t.toUpperCase()) {
    t = t.toLowerCase().replace(/\b([a-z])([a-z]*)/g, (w, a, b) => (/^(of|and|to|in|for|the|on|a|an)$/.test(w) ? w : a.toUpperCase() + b))
    // Roman numerals stay capitals (I, II, III, IV…).
    t = t.replace(/\b(i{1,3}|iv|vi{0,3}|ix|x)\b/gi, (m) => m.toUpperCase())
    t = t.charAt(0).toUpperCase() + t.slice(1)
  }
  return t
}

// PDF -> library -> requests fulfilled -> admins told. Used by the server's
// own writer and by the Kaggle worker once its last chapter arrives.
async function finishNotes(job, notes) {
  notes = { ...notes, courseTitle: tidyCourseTitle(notes.courseTitle) || notes.courseTitle }
  const pdf = await renderNotesPdf(notes)
  const { resource, published } = await publishNotes(job, notes, pdf)
  await query(
    `UPDATE ai_jobs SET status = 'done', progress = 100, step = $2, resource_id = $3, provider = $4, finished_at = now(), draft = NULL, retry_after = NULL WHERE id = $1`,
    [job.id, published ? 'Published' : 'Waiting for review', resource.id, `${notes.provider}${notes.model ? ` (${notes.model})` : ''}`]
  )
  // Other jobs for the same course that haven't got as far (e.g. started by
  // pressing Regenerate on a failed one): this finished copy serves them too.
  const dupes = await query(
    `UPDATE ai_jobs SET status = 'done', progress = 100, step = 'Same course already written', resource_id = $3,
            claimed_by = NULL, finished_at = now(), draft = NULL
     WHERE kind = 'lecture_notes' AND course_key = $1 AND id <> $2 AND status IN ('queued', 'running', 'failed')
       AND NOT (coalesce(draft, '{}'::jsonb) ? 'revision')
     RETURNING request_ids`,
    [job.course_key, job.id, resource.id]
  ).catch(() => ({ rows: [] }))
  const extraRequests = dupes.rows.flatMap((r) => r.request_ids || [])

  const fulfilled = published ? await fulfilRequests([...(job.request_ids || []), ...extraRequests], resource, { aiWritten: true }) : 0
  await notifyAdmins({
    type: 'ai_notes',
    title: `✍️ AI wrote lecture notes: ${resource.title}`,
    resourceId: resource.id,
    thumbnailUrl: resource.thumbnail_url || null,
    body: `${notes.chapters.length} weeks, ${Math.round(pdf.length / 1024)} KB.${published ? ' Live in the library.' : ' Waiting for your review.'}${fulfilled ? ` Sent to ${fulfilled} ${fulfilled === 1 ? 'person' : 'people'} who asked.` : ''}`,
    url: '/admin/ai-library',
  })
  return resource
}

async function runJob(job) {
  let lastSave = 0
  const progress = (pct, step) => {
    // Saved at most every few seconds; the admin page polls it.
    if (Date.now() - lastSave < 3000 && pct < 100) return
    lastSave = Date.now()
    query(`UPDATE ai_jobs SET progress = $2, step = $3 WHERE id = $1`, [job.id, pct, step]).catch(() => {})
  }
  try {
    const course = job.course_code ? await lookupCourse(job.course_code) : {}
    const notes = await generateCourseNotes(
      { courseCode: job.course_code, title: job.title || course.title, level: job.level || course.level, department: course.departmentName },
      progress,
      {
        draft: job.draft,
        saveDraft: (draft) => query(`UPDATE ai_jobs SET draft = $2 WHERE id = $1`, [job.id, JSON.stringify(draft)]),
      }
    )
    // Taken back for being too slow (another run owns it now): don't publish twice.
    // The database keeps microseconds but job.started_at (a JS Date) only
    // milliseconds, so an exact "=" never matched and nothing was published.
    const still = await query(
      `SELECT 1 FROM ai_jobs WHERE id = $1 AND status = 'running'
         AND abs(extract(epoch FROM (started_at - $2::timestamptz))) < 0.001`,
      [job.id, job.started_at]
    )
    if (!still.rows.length) return
    progress(96, 'Publishing to the library')
    await finishNotes(job, notes)
  } catch (err) {
    // The free AI limit ran out: not a failure. Keep what's written and
    // carry on automatically once it resets.
    if (err.code === 'QUOTA') {
      const saved = await query(`SELECT draft FROM ai_jobs WHERE id = $1`, [job.id]).catch(() => ({ rows: [] }))
      const { weeks, written } = draftProgress(saved.rows[0]?.draft)
      const done = weeks ? ` ${written} of ${weeks} weeks written so far.` : ''
      await query(
        `UPDATE ai_jobs SET status = 'queued', retry_after = now() + interval '1 hour', error = NULL,
                step = $2 WHERE id = $1`,
        [job.id, `Waiting for the free AI limit to reset; continues by itself every hour.${done}`]
      )
      console.warn(`AI notes job ${job.id} paused: free AI limit reached.${done}`)
      return
    }
    console.error(`AI notes job ${job.id} failed:`, err.message)
    await query(`UPDATE ai_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [job.id, String(err.message).slice(0, 500)])
    await notifyAdmins({
      type: 'ai_notes_failed',
      title: '⚠️ AI lecture notes failed',
      body: `${job.course_code || job.title}: ${String(err.message).slice(0, 140)}. Retry it from AI Library.`,
      url: '/admin/ai-library',
    }).catch(() => {})
  }
}

// One job at a time, oldest first. Survives restarts: jobs left "running"
// when the server stopped are queued again on start.
// The server's own writer (Gemini, then Groq). While your Kaggle AI is
// online it writes better notes, so the server leaves new writing to it and
// only publishes jobs that are already fully written.
const SERVER_JOB_LIMIT_MS = 45 * 60 * 1000 // a job taking longer than this is stuck
let working = false
let workingSince = 0

export function kickWorker() {
  // A run that's been "busy" far too long is stuck (e.g. a hung upload):
  // let a fresh run start; its job is put back in the queue below.
  if (working && Date.now() - workingSince < SERVER_JOB_LIMIT_MS + 5 * 60 * 1000) return
  working = true
  workingSince = Date.now()
  ;(async () => {
    try {
      await releaseSilentWorkerJobs()
      await releaseStuckServerJobs()
      for (;;) {
        const kaggleOnline = (await workerStatus()).online
        const next = await query(
          `UPDATE ai_jobs SET status = 'running', started_at = now(), step = 'Starting', error = NULL, claimed_by = 'server'
           WHERE id = (SELECT id FROM ai_jobs WHERE status = 'queued' AND (retry_after IS NULL OR retry_after <= now())
                         AND ($1::boolean = false OR coalesce(draft, '{}'::jsonb) ? 'revision')
                       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING *`,
          [kaggleOnline]
        )
        if (!next.rows.length) break
        workingSince = Date.now()
        const job = next.rows[0]
        let timer
        await Promise.race([
          runJob(job),
          new Promise((resolve) => {
            timer = setTimeout(async () => {
              console.error(`AI notes job ${job.id} took over 45 minutes; putting it back in the queue`)
              await query(
                `UPDATE ai_jobs SET status = 'queued', claimed_by = NULL, retry_after = now() + interval '10 minutes',
                        step = 'Took too long; trying again shortly (progress kept)' WHERE id = $1 AND status = 'running'`,
                [job.id]
              ).catch(() => {})
              resolve()
            }, SERVER_JOB_LIMIT_MS)
          }),
        ])
        clearTimeout(timer)
      }
    } catch (err) {
      console.error('AI library worker stopped:', err.message)
    } finally {
      working = false
    }
  })()
}

// Server jobs left "running" with no progress for 45+ minutes (the server
// restarted, or a step hung): back to the queue, keeping what's written.
async function releaseStuckServerJobs() {
  await query(
    `UPDATE ai_jobs SET status = 'queued', claimed_by = NULL, step = 'Restarting a stuck job (progress kept)'
     WHERE status = 'running' AND claimed_by IS DISTINCT FROM 'kaggle'
       AND started_at < now() - interval '45 minutes'`
  ).catch(() => {})
}

let ticking = null
export async function startAiLibrary() {
  try {
    await ensureAiTables()
    await query(`UPDATE ai_jobs SET status = 'queued' WHERE status = 'running' AND claimed_by IS DISTINCT FROM 'kaggle'`)
    kickWorker()
    // Picks up jobs waiting for the AI limit, and stuck ones.
    ticking ||= setInterval(kickWorker, 5 * 60 * 1000)
  } catch (err) {
    console.error('AI library start failed:', err.message)
  }
}

// Failed, or waiting for the limit: try again right now (keeps what's written).
export async function retryJob(id) {
  await ensureAiTables()
  const r = await query(
    `UPDATE ai_jobs SET status = 'queued', step = NULL, error = NULL, retry_after = NULL
     WHERE id = $1 AND (status = 'failed' OR (status = 'queued' AND retry_after IS NOT NULL)) RETURNING id`,
    [id]
  )
  if (r.rows.length) kickWorker()
  return r.rows.length > 0
}

// Every failed job back in the queue, keeping what's written. Fully written
// ones just get published (no AI needed).
export async function retryAllFailed() {
  await ensureAiTables()
  const r = await query(
    `UPDATE ai_jobs SET status = 'queued', step = 'Continuing from the saved work', error = NULL, retry_after = NULL,
            claimed_by = NULL, finished_at = NULL
     WHERE status = 'failed' RETURNING id`
  )
  if (r.rows.length) kickWorker()
  return r.rows.length
}

// ---------- Your own AI on Kaggle (the "worker") ----------
// The notebook only runs the model. The server tells it what to write next
// (plan -> each week -> revision), keeps the draft, and makes the PDF, so
// the notebook never needs updating when the notes change.

// A Kaggle job with no sign of life for 15 minutes (notebook stopped) goes
// back to the queue, keeping everything written so far.
export async function releaseSilentWorkerJobs() {
  await query(
    `UPDATE ai_jobs SET status = 'queued', claimed_by = NULL, step = 'Your Kaggle AI stopped; continuing here'
     WHERE status = 'running' AND claimed_by = 'kaggle' AND worker_seen < now() - interval '15 minutes'`
  ).catch(() => {})
}

export async function workerHeartbeat(model) {
  await ensureAiTables()
  await query(
    `INSERT INTO ai_worker_status (id, last_seen, model) VALUES (1, now(), $1)
     ON CONFLICT (id) DO UPDATE SET last_seen = now(), model = COALESCE($1, ai_worker_status.model)`,
    [model ? String(model).slice(0, 80) : null]
  )
}

export async function workerStatus() {
  await ensureAiTables()
  const r = await query(`SELECT last_seen, model, jobs_done FROM ai_worker_status WHERE id = 1`)
  const row = r.rows[0]
  return {
    online: Boolean(row?.last_seen && Date.now() - new Date(row.last_seen).getTime() < 3 * 60 * 1000),
    lastSeen: row?.last_seen || null,
    model: row?.model || null,
    jobsDone: row?.jobs_done || 0,
  }
}

function taskFor(job, draft) {
  const course = { courseCode: job.course_code, title: job.title, level: job.level, department: job.department }
  if (!draft?.plan) {
    return { kind: 'plan', system: TEACHER, prompt: planPrompt(course), maxTokens: 6000 }
  }
  const plan = draft.plan
  const chapters = draft.chapters || []
  const week = plan.schemeOfWork.find((w) => !chapters.some((c) => c.week === w.week))
  if (week) return { kind: 'chapter', week: week.week, system: TEACHER, prompt: chapterPrompt(plan, week), maxTokens: 12000 }
  if (!draft.revision) return { kind: 'revision', system: TEACHER, prompt: revisionPrompt(plan), maxTokens: 12000 }
  return null
}

function progressFor(draft) {
  const weeks = draft?.plan?.schemeOfWork?.length || 0
  const written = draft?.chapters?.length || 0
  if (!draft?.plan) return [3, 'Your Kaggle AI is planning the course']
  if (written < weeks) return [10 + Math.round((written / (weeks + 1)) * 80), `Your Kaggle AI is writing week ${written + 1} of ${weeks}`]
  return [88, 'Your Kaggle AI is writing the revision chapter']
}

// Hands the worker the oldest waiting job (including ones paused by the
// free Gemini/Groq limits) and its first step. null = nothing to do.
export async function workerClaim(model) {
  await ensureAiTables()
  await workerHeartbeat(model)
  await releaseSilentWorkerJobs()
  // A job that's already fully written only needs publishing: do it here
  // and look for the next one, so the worker always gets real writing.
  for (let i = 0; i < 20; i += 1) {
    const claimed = await claimOne()
    if (!claimed) return null
    if (claimed.task) return { jobId: claimed.jobId, title: claimed.title, task: claimed.task }
    await query(`UPDATE ai_jobs SET progress = 96, step = 'Publishing to the library' WHERE id = $1`, [claimed.jobId])
    await finishNotes(claimed.job, notesFromDraft(claimed.job.draft)).catch(async (err) => {
      await query(`UPDATE ai_jobs SET status = 'failed', error = $2, claimed_by = NULL WHERE id = $1`, [claimed.jobId, String(err.message).slice(0, 500)])
    })
  }
  return null
}

function notesFromDraft(draft) {
  return {
    ...draft.plan,
    chapters: [...(draft.chapters || [])].sort((a, b) => a.week - b.week),
    revision: draft.revision,
    provider: 'kaggle',
    model: (draft.writers || []).join(' + ') || 'own model',
  }
}

async function claimOne() {
  const r = await query(
    `UPDATE ai_jobs SET status = 'running', claimed_by = 'kaggle', worker_seen = now(), retry_after = NULL, error = NULL,
            started_at = COALESCE(started_at, now())
     WHERE id = (SELECT id FROM ai_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`
  )
  const job = r.rows[0]
  if (!job) return null
  const course = job.course_code ? await lookupCourse(job.course_code) : {}
  const info = { ...job, title: job.title || course.title, level: job.level || course.level, department: course.departmentName }
  const [progress, step] = progressFor(job.draft)
  await query(`UPDATE ai_jobs SET progress = $2, step = $3 WHERE id = $1`, [job.id, progress, step])
  return { jobId: job.id, job, title: [job.course_code, info.title].filter(Boolean).join(' – '), task: taskFor(info, job.draft) }
}

// The worker's answer to one step. Saves it, then returns the next step, or
// { done: true } after publishing.
export async function workerAnswer(jobId, { kind, week, text, model }) {
  const r = await query(`SELECT * FROM ai_jobs WHERE id = $1 AND status = 'running' AND claimed_by = 'kaggle'`, [jobId])
  const job = r.rows[0]
  if (!job) throw Object.assign(new Error('This job is no longer assigned to your Kaggle AI'), { status: 409 })
  const draft = job.draft || {}
  const clean = cleanText(text)
  if (!clean) throw Object.assign(new Error('Empty answer'), { status: 400 })

  if (kind === 'plan') {
    const course = job.course_code ? await lookupCourse(job.course_code) : {}
    try {
      draft.plan = parsePlan(clean, { courseCode: job.course_code, title: job.title || course.title, level: job.level || course.level })
    } catch (err) {
      // Unreadable plan: ask the model to write the plan again.
      console.warn(`Kaggle plan for ${job.course_code || job.title} unreadable (${err.message}); asking again`)
      await query(`UPDATE ai_jobs SET worker_seen = now(), step = 'Your Kaggle AI is planning the course again' WHERE id = $1`, [jobId])
      const info = { ...job, title: job.title || course.title, level: job.level || course.level, department: course.departmentName }
      return { next: taskFor(info, null) }
    }
    draft.chapters = []
  } else if (kind === 'chapter') {
    const w = draft.plan?.schemeOfWork?.find((x) => x.week === Number(week))
    if (!w) throw Object.assign(new Error('Unknown week'), { status: 400 })
    draft.chapters = [...(draft.chapters || []).filter((c) => c.week !== w.week), { ...w, markdown: clean }]
  } else if (kind === 'revision') {
    draft.revision = clean
  } else {
    throw Object.assign(new Error('Unknown step'), { status: 400 })
  }
  draft.writers = [...new Set([...(draft.writers || []), `kaggle/${model || 'own-model'}`])]

  const [progress, step] = progressFor(draft)
  await query(`UPDATE ai_jobs SET draft = $2, progress = $3, step = $4, worker_seen = now() WHERE id = $1`, [jobId, JSON.stringify(draft), progress, step])
  await workerHeartbeat(model)

  const course = job.course_code ? await lookupCourse(job.course_code) : {}
  const next = taskFor({ ...job, title: job.title || course.title, level: job.level || course.level, department: course.departmentName }, draft)
  if (next) return { next }

  // All written: make the PDF and publish (same as the server's own writer).
  await query(`UPDATE ai_jobs SET progress = 96, step = 'Publishing to the library' WHERE id = $1`, [jobId])
  const resource = await finishNotes(job, notesFromDraft(draft))
  await query(`UPDATE ai_worker_status SET jobs_done = jobs_done + 1 WHERE id = 1`).catch(() => {})
  return { done: true, resourceId: resource.id, title: resource.title }
}

// The worker hit a problem with this job: back to the queue, keeping the draft.
export async function workerRelease(jobId, error) {
  await query(
    `UPDATE ai_jobs SET status = 'queued', claimed_by = NULL, step = $2
     WHERE id = $1 AND status = 'running' AND claimed_by = 'kaggle'`,
    [jobId, `Your Kaggle AI stopped on this one (${String(error || 'unknown').slice(0, 120)}); it will be picked up again`]
  )
}

// ---------- Bro Paul uploads ----------
function guessType(text) {
  if (PAST_QUESTION_RE.test(text)) return 'past_question'
  if (LECTURE_NOTES_RE.test(text)) return 'lecture_notes'
  return null
}

// Is this really study material? Bro Paul used to judge by the caption alone,
// so a church flyer saying "ETF Lecture Hall" went into the library. Now the
// AI looks at the actual picture(s) or PDF first.
// Returns { verdict: 'material' | 'not_material' | 'unknown', type, reason, title, courseCode }.
const MATERIAL_CHECK = `You check files that people sent to a university library's WhatsApp assistant, and decide if they are STUDY MATERIAL for the library.

Study material: past question papers or exam/test questions (even one photographed page), lecture notes or handouts, textbook or book pages, course outlines, assignments/tutorial sheets with academic questions, academic slides, research papers, devotional or Christian books.
NOT study material: event flyers or posters (church services, programmes, concerts, birthdays, adverts), memes, selfies or photos of people/places, screenshots of chats, receipts, ID cards, timetables of events, announcements, certificates, random photos.

Reply with ONLY one JSON object:
{"material": true or false, "type": "past_question" | "lecture_notes" | "book" | "handout" | "slides" | "other_study" | "not_study", "reason": "max 12 words", "title": "a clear title if it is study material, else empty", "courseCode": "e.g. MTH 211 if visible, else empty"}`

async function classifyMaterial({ files, caption }) {
  const key = process.env.GEMINI_API_KEY
  if (!key) return { verdict: 'unknown', reason: 'No AI key' }
  const parts = []
  const images = files.filter((f) => f.mimetype?.startsWith('image/')).slice(0, 3)
  for (const img of images) {
    const small = await sharp(img.buffer).rotate().resize({ width: 1100, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer()
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } })
  }
  const pdf = files.find((f) => f.mimetype === 'application/pdf')
  if (!images.length && pdf) {
    if (pdf.buffer.length > 12 * 1024 * 1024) return { verdict: 'unknown', reason: 'PDF too large to check' }
    parts.push({ inlineData: { mimeType: 'application/pdf', data: pdf.buffer.toString('base64') } })
  }
  if (!parts.length) return { verdict: 'unknown', reason: 'File type not checkable' } // Word/PowerPoint
  parts.push({ text: `Caption or file name: "${String(caption || '').slice(0, 300)}"` })

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: MATERIAL_CHECK }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0, maxOutputTokens: 300, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) return { verdict: 'unknown', reason: `AI check unavailable (${res.status})` }
    const data = await res.json()
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('')
    const out = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim())
    return {
      verdict: out.material === true ? 'material' : 'not_material',
      type: out.type || null,
      reason: String(out.reason || '').slice(0, 120),
      title: String(out.title || '').slice(0, 160),
      courseCode: String(out.courseCode || '').slice(0, 20),
    }
  } catch (err) {
    return { verdict: 'unknown', reason: `AI check failed: ${err.message}`.slice(0, 120) }
  }
}

// Photos of past questions arrive as several images: one PDF, page per image.
async function imagesToPdf(files) {
  const pdf = await PDFDocument.create()
  for (const f of files) {
    const jpg = await sharp(f.buffer).rotate().resize({ width: 1700, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
    const img = await pdf.embedJpg(jpg)
    const page = pdf.addPage([img.width, img.height])
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height })
  }
  return Buffer.from(await pdf.save())
}

// files: [{ buffer, mimetype, originalname }] (several images become one PDF).
// Returns { status: 'published' | 'pending' | 'duplicate', resourceId, title, url, fulfilled }.
// confirmed = the sender said it's for the library (answered Bro Paul's
// "is this for the library?" with a course code), so an AI check that
// couldn't run (or guessed wrong) doesn't block it; they said so in a DM.
export async function publishBotUpload({ files, caption = '', courseCode, type, whatsappName = '', groupName = '', confirmed = false }) {
  await ensureAiTables()
  const settings = await getBotSettings()
  const images = files.filter((f) => f.mimetype?.startsWith('image/'))
  const allImages = images.length > 0 && images.length === files.length

  // The very same file (or set of photos) already in the library: point to
  // it, before spending any AI on it. Photos are fingerprinted themselves,
  // since the PDF made from them is different every time.
  const mainFile = allImages ? null : files.find((x) => !x.mimetype?.startsWith('image/')) || files[0]
  const sha = allImages ? fingerprintAll(images.map((x) => x.buffer)) : fingerprint(mainFile.buffer)
  const dup = await findDuplicate(sha)
  if (dup) return { status: 'duplicate', resourceId: dup.id, title: dup.title, url: `${SITE_URL}/library/${dup.id}`, fulfilled: 0 }

  const check = await classifyMaterial({ files, caption: `${caption} ${files.map((x) => x.originalname || '').join(' ')}` })
  if (check.verdict === 'not_material' && !confirmed) return { status: 'not_material', reason: check.reason }
  const checkable = images.length > 0 || files.some((x) => x.mimetype === 'application/pdf')
  if (check.verdict === 'unknown' && checkable && !confirmed) return { status: 'unverified', reason: check.reason }
  let file
  if (allImages) {
    const buffer = await imagesToPdf(images)
    file = { buffer, mimetype: 'application/pdf', originalname: 'whatsapp-upload.pdf', size: buffer.length }
  } else {
    file = { ...mainFile, size: mainFile.buffer.length }
  }

  const hint = `${caption} ${file.originalname || ''}`
  const aiType = ['past_question', 'lecture_notes', 'book'].includes(check.type) ? check.type : check.type === 'handout' ? 'lecture_notes' : null
  let slug = type || guessType(hint) || aiType
  let code =
    normalizeCourseCode(courseCode) ||
    normalizeCourseCode((/\b([A-Za-z]{3})\s?-?(\d{3})\b/.exec(hint) || []).slice(1).join(' ')) ||
    normalizeCourseCode(check.courseCode)
  let title = check.title || null
  let author = null

  // Let the AI read the file for a proper title / course / author.
  try {
    const filenameTitle = (file.originalname || '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
    const suggestion = await analyzeResourceFile({
      buffer: file.buffer,
      mimetype: file.mimetype,
      extractedText: null,
      resourceTypeSlug: slug || 'other',
      filenameTitle: /^(whatsapp|img|doc|document|file|scan)\b/i.test(filenameTitle) ? null : filenameTitle,
    })
    if (suggestion) {
      title = suggestion.title || title
      author = suggestion.author || null
      if (!code && suggestion.course?.code) code = normalizeCourseCode(suggestion.course.code)
      if (!slug) slug = guessType(`${suggestion.title || ''} ${suggestion.description || ''}`)
    }
  } catch (err) {
    console.warn('Bot upload analysis skipped:', err.message)
  }

  slug ||= 'other'
  const course = await lookupCourse(code)
  const label = slug === 'past_question' ? 'Past Questions' : slug === 'lecture_notes' ? 'Lecture Notes' : ''
  if (!title || /^untitled/i.test(title)) title = [course.code || code, course.title, label].filter(Boolean).join(' ') || 'Shared material'
  if (label && !new RegExp(label.split(' ')[0], 'i').test(title)) title = `${title} ${label}`
  title = await uniqueTitle(title, author)

  const stored = await uploadToStorage(file, resolveUploadCategory({ mimetype: file.mimetype, resourceTypeSlug: slug }))
  const status = settings.autoPublishUploads ? 'approved' : 'pending'
  const who = whatsappName ? whatsappName.split(' ')[0] : 'a member'
  const description = `Shared on WhatsApp by ${who}${groupName ? ` in ${groupName}` : ''}. Added to the library by Bro Paul.${caption ? ` Note: "${caption.slice(0, 200)}"` : ''}`
  const inserted = await query(
    `INSERT INTO resources (
       title, author, description, course_code, department_id, level, resource_type_id,
       storage_provider, file_id, file_url, file_name, file_type, file_size_bytes,
       uploaded_by, is_anonymous, thumbnail_status, status, reviewed_at, ai_origin, file_sha256
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,'pending',$15::resource_status,
               CASE WHEN $15::text = 'approved' THEN now() END,'bot_upload',$16)
     RETURNING id, title, thumbnail_url`,
    [
      title, author, description, course.code || code || null, course.departmentId || null, course.level || null, await typeId(slug),
      stored.provider, stored.fileId, stored.fileUrl, file.originalname || 'whatsapp-upload', file.mimetype, file.size,
      await getSystemUserId(), status, sha,
    ]
  )
  const resource = inserted.rows[0]
  try {
    queuePreviewGeneration(resource.id, stored, file.mimetype, file.buffer, null)
  } catch (err) {
    console.error('Preview queue failed for bot upload:', err.message)
  }

  // Open requests for this course (and kind, when the request says) are fulfilled.
  let fulfilled = 0
  if (status === 'approved' && (course.code || code)) {
    const key = courseKey(course.code || code)
    const open = await query(
      `SELECT id, title, details FROM material_requests
       WHERE status = 'open' AND upper(replace(coalesce(course_code, ''), ' ', '')) = $1`,
      [key]
    )
    const matching = open.rows.filter((r) => {
      const asked = r.details?.type || guessType(`${r.title} ${r.details?.asked || ''}`)
      return !asked || asked === slug
    })
    fulfilled = await fulfilRequests(matching.map((r) => r.id), resource)
  }

  await notifyAdmins({
    type: 'bot_upload',
    title: `📥 Bro Paul added: ${resource.title}`,
    resourceId: resource.id,
    thumbnailUrl: resource.thumbnail_url || null,
    body: `Sent on WhatsApp by ${whatsappName || 'a member'}${groupName ? ` in ${groupName}` : ''}.${status === 'approved' ? ' Live in the library.' : ' Waiting for your review.'}${fulfilled ? ` Fulfilled ${fulfilled} request${fulfilled === 1 ? '' : 's'}.` : ''}`,
    url: '/admin/ai-library',
  }).catch(() => {})

  return { status: status === 'approved' ? 'published' : 'pending', resourceId: resource.id, title: resource.title, url: `${SITE_URL}/library/${resource.id}`, fulfilled }
}

// ---------- asking groups for past questions ----------
// Posts "who has … past questions?" in the groups an admin picked, at most
// once a day per course per group. skipGroup = where the person asked
// (Bro Paul's reply there already asks).
export async function askGroupsForMaterial({ title, courseCode, askerName, skipGroup }) {
  const settings = await getBotSettings()
  if (!settings.askForMaterials) return 0
  const groups = await query(
    `SELECT jid FROM whatsapp_groups
     WHERE enabled = true AND coalesce((settings->>'askForMaterials')::boolean, false) = true
       AND coalesce((settings->>'left')::boolean, false) = false
       AND coalesce((settings->>'started')::boolean, true) = true`
  )
  const what = [normalizeCourseCode(courseCode), title].filter(Boolean)[0] || title
  const systemId = await getSystemUserId()
  let asked = 0
  for (const { jid } of groups.rows) {
    if (jid === skipGroup) continue
    const recent = await query(
      `SELECT 1 FROM whatsapp_bot_outbox WHERE group_jid = $1 AND kind = 'material_ask' AND text ILIKE '%' || $2 || '%'
       AND created_at > now() - interval '24 hours' LIMIT 1`,
      [jid, what]
    )
    if (recent.rows.length) continue
    const text =
      `📚 Quick one, family: does anyone have *${title}*? ${askerName ? `${askerName.split(' ')[0]} is` : 'Someone is'} looking for it 🙏\n\n` +
      `If you have it, please send it to me in DM (or reply to this message with the file). I'll add it to the library so everyone can use it, and you'll be the hero of the day 🦸🏾`
    await query(`INSERT INTO whatsapp_bot_outbox (group_jid, text, kind, created_by) VALUES ($1, $2, 'material_ask', $3)`, [jid, text, systemId])
    asked += 1
  }
  return asked
}

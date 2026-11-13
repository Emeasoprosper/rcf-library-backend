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
import { generateCourseNotes, notesProvider } from './noteGenerator.js'
import { renderNotesPdf } from './notesPdf.js'
import { isWhatsappRequest, readyMessage, SITE_URL } from './whatsappRequests.js'
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

async function notifyAdmins({ title, body, url, type }) {
  const admins = await query(`SELECT id FROM users WHERE role IN ('admin', 'superadmin') AND is_suspended = false`)
  const ids = admins.rows.map((r) => r.id)
  if (!ids.length) return
  await query(
    `INSERT INTO notifications (user_id, type, title, body, link_to) SELECT unnest($1::uuid[]), $2, $3, $4, $5`,
    [ids, type, title, body, url]
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
      const text = readyMessage({
        whatsappName: row.details.whatsappName,
        requestTitle: row.title,
        resourceId: resource.id,
        resourceTitle: resource.title,
        aiWritten,
      })
      await query(`INSERT INTO whatsapp_bot_outbox (group_jid, text, kind, created_by) VALUES ($1, $2, 'request_ready', $3)`, [
        row.details.whatsappId,
        text,
        systemId,
      ]).catch(() => query(`INSERT INTO whatsapp_bot_outbox (group_jid, text) VALUES ($1, $2)`, [row.details.whatsappId, text]))
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
  return result.rows[0] || null
}

// Queues notes for a course (or joins an identical job already queued).
// Returns { status: 'exists' | 'queued' | 'disabled' | 'unavailable', resourceId?, jobId? }.
export async function requestLectureNotes({ courseCode, title, level, requestIds = [], requestedBy = '', force = false }) {
  await ensureAiTables()
  const settings = await getBotSettings()
  if (!force && !settings.aiLectureNotes) return { status: 'disabled' }
  if (!notesProvider()) return { status: 'unavailable' }

  const code = normalizeCourseCode(courseCode)
  const cleanTitle = String(title || '')
    .replace(LECTURE_NOTES_RE, '')
    .replace(/\b(please|pls|for|on|the|i need|need)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!code && cleanTitle.length < 3) return { status: 'unavailable' }

  if (!force) {
    const found = await existingNotes(code, cleanTitle)
    if (found) {
      if (requestIds.length) await fulfilRequests(requestIds, found)
      return { status: 'exists', resourceId: found.id, title: found.title }
    }
  }

  const key = code ? courseKey(code) : cleanTitle.toLowerCase()
  const active = await query(
    `UPDATE ai_jobs SET request_ids = (SELECT array_agg(DISTINCT x) FROM unnest(request_ids || $2::uuid[]) x)
     WHERE kind = 'lecture_notes' AND course_key = $1 AND status IN ('queued', 'running')
     RETURNING id`,
    [key, requestIds]
  )
  if (active.rows.length) return { status: 'queued', jobId: active.rows[0].id }

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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'application/pdf',$12,$13,false,'pending',$14,
               CASE WHEN $14 = 'approved' THEN now() END,'generated',$15)
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
      progress
    )
    const pdf = await renderNotesPdf(notes)
    progress(96, 'Publishing to the library')
    const { resource, published } = await publishNotes(job, notes, pdf)
    await query(
      `UPDATE ai_jobs SET status = 'done', progress = 100, step = $2, resource_id = $3, provider = $4, finished_at = now() WHERE id = $1`,
      [job.id, published ? 'Published' : 'Waiting for review', resource.id, `${notes.provider}${notes.model ? ` (${notes.model})` : ''}`]
    )
    const fulfilled = published ? await fulfilRequests(job.request_ids || [], resource, { aiWritten: true }) : 0
    await notifyAdmins({
      type: 'ai_notes',
      title: `✍️ AI wrote lecture notes: ${resource.title}`,
      body: `${notes.chapters.length} weeks, ${Math.round(pdf.length / 1024)} KB.${published ? ' Live in the library.' : ' Waiting for your review.'}${fulfilled ? ` Sent to ${fulfilled} ${fulfilled === 1 ? 'person' : 'people'} who asked.` : ''}`,
      url: '/admin/ai-library',
    })
  } catch (err) {
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
let working = false
export function kickWorker() {
  if (working) return
  working = true
  ;(async () => {
    try {
      for (;;) {
        const next = await query(
          `UPDATE ai_jobs SET status = 'running', started_at = now(), step = 'Starting', error = NULL
           WHERE id = (SELECT id FROM ai_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING *`
        )
        if (!next.rows.length) break
        await runJob(next.rows[0])
      }
    } catch (err) {
      console.error('AI library worker stopped:', err.message)
    } finally {
      working = false
    }
  })()
}

export async function startAiLibrary() {
  try {
    await ensureAiTables()
    await query(`UPDATE ai_jobs SET status = 'queued' WHERE status = 'running'`)
    kickWorker()
  } catch (err) {
    console.error('AI library start failed:', err.message)
  }
}

export async function retryJob(id) {
  await ensureAiTables()
  const r = await query(`UPDATE ai_jobs SET status = 'queued', progress = 0, step = NULL, error = NULL WHERE id = $1 AND status = 'failed' RETURNING id`, [id])
  if (r.rows.length) kickWorker()
  return r.rows.length > 0
}

// ---------- Bro Paul uploads ----------
function guessType(text) {
  if (PAST_QUESTION_RE.test(text)) return 'past_question'
  if (LECTURE_NOTES_RE.test(text)) return 'lecture_notes'
  return null
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
export async function publishBotUpload({ files, caption = '', courseCode, type, whatsappName = '', groupName = '' }) {
  await ensureAiTables()
  const settings = await getBotSettings()
  const images = files.filter((f) => f.mimetype?.startsWith('image/'))
  let file
  if (images.length && images.length === files.length) {
    const buffer = await imagesToPdf(images)
    file = { buffer, mimetype: 'application/pdf', originalname: 'whatsapp-upload.pdf', size: buffer.length }
  } else {
    const f = files.find((x) => !x.mimetype?.startsWith('image/')) || files[0]
    file = { ...f, size: f.buffer.length }
  }

  // The very same file sent twice (common in groups) is only added once.
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex')
  const dup = await query(`SELECT id, title FROM resources WHERE file_sha256 = $1 AND status <> 'rejected' LIMIT 1`, [sha])
  if (dup.rows.length) return { status: 'duplicate', resourceId: dup.rows[0].id, title: dup.rows[0].title, url: `${SITE_URL}/library/${dup.rows[0].id}`, fulfilled: 0 }

  const hint = `${caption} ${file.originalname || ''}`
  let slug = type || guessType(hint)
  let code = normalizeCourseCode(courseCode) || normalizeCourseCode((/\b([A-Za-z]{3})\s?-?(\d{3})\b/.exec(hint) || []).slice(1).join(' '))
  let title = null
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
      title = suggestion.title || null
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,'pending',$15,
               CASE WHEN $15 = 'approved' THEN now() END,'bot_upload',$16)
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

import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { uploadToStorage, deleteFromStorage } from './storage.js'
import { resolveUploadCategory } from '../config/driveFolders.js'
import { queuePreviewGeneration } from './previewQueue.js'
import { getImportableItem } from './archiveSearch.js'

const UA = { 'User-Agent': 'RCF-MOUAU-Library/1.0 (+https://rcf-mouau-library.vercel.app)' }
const MAX_BYTES = 60 * 1024 * 1024
const PER_USER_PER_DAY = 5
const TOTAL_PER_DAY = 40

const jobs = new Map()
let busy = false

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function safeFileName(title) {
  const base = String(title || 'book').replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return `${base || 'book'}.pdf`
}

async function downloadCapped(url) {
  const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`archive.org returned ${res.status} for the file`)
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_BYTES) throw new Error('File is too large')
  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > MAX_BYTES) throw new Error('File is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function runImport(item, userId, job) {
  let stored = null
  let inserted = false
  try {
    const encodedPath = item.pdfName.split('/').map(encodeURIComponent).join('/')
    const buffer = await downloadCapped(`https://archive.org/download/${encodeURIComponent(item.identifier)}/${encodedPath}`)
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Downloaded file is not a valid PDF')

    const file = { originalname: safeFileName(item.title), mimetype: 'application/pdf', buffer, size: buffer.length }
    const driveCategory = resolveUploadCategory({ mimetype: 'application/pdf', resourceTypeSlug: 'book' })
    stored = await uploadToStorage(file, driveCategory)

    const typeResult = await query(`SELECT id FROM resource_types WHERE slug = 'book'`)
    if (typeResult.rows.length === 0) throw new Error('Book resource type is missing')

    const description =
      `Source: Internet Archive (${item.sourceUrl}) · Licence: ${item.licence}` +
      `${item.year ? ` · Published ${item.year}` : ''}. Added on request through the RCF library.`

    const result = await query(
      `INSERT INTO resources (
         title, author, description, resource_type_id,
         storage_provider, file_id, file_url, file_name, file_type, file_size_bytes,
         uploaded_by, is_anonymous, thumbnail_status, status, reviewed_at,
         external_source, external_id, external_url, external_licence
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'application/pdf',$9,$10,true,'pending','approved',now(),
                 'internet_archive',$11,$12,$13)
       RETURNING id`,
      [
        item.title, item.author, description, typeResult.rows[0].id,
        stored.provider, stored.fileId, stored.fileUrl, file.originalname, buffer.length,
        userId, item.identifier, item.sourceUrl, item.licence,
      ]
    )
    inserted = true
    const resourceId = result.rows[0].id

    try {
      queuePreviewGeneration(resourceId, stored, 'application/pdf', buffer, null)
    } catch (err) {
      console.error('Preview queue failed for imported resource:', err.message)
    }

    job.state = 'done'
    job.resourceId = resourceId
  } catch (err) {
    console.error(`External import failed for ${item.identifier}:`, err.message)
    if (stored && !inserted) await deleteFromStorage(stored.fileId).catch(() => {})
    job.state = 'failed'
    job.error = err.message
  } finally {
    busy = false
  }
}

export async function startImport(identifier, userId) {
  for (const [id, job] of jobs) if (Date.now() - job.at > 60 * 60 * 1000) jobs.delete(id)

  const item = await getImportableItem(identifier)

  const existing = await query(
    `SELECT id, status FROM resources WHERE external_source = 'internet_archive' AND external_id = $1`,
    [identifier]
  )
  if (existing.rows.length > 0) {
    if (existing.rows[0].status === 'approved') return { alreadyInLibrary: true, resourceId: existing.rows[0].id }
    throw httpError(409, 'This book was already added and is not currently available')
  }

  const mine = await query(
    `SELECT COUNT(*)::int AS n FROM resources
     WHERE external_source IS NOT NULL AND uploaded_by = $1 AND created_at > now() - interval '24 hours'`,
    [userId]
  )
  if (mine.rows[0].n >= PER_USER_PER_DAY) throw httpError(429, 'Daily limit reached for adding external books')

  const all = await query(
    `SELECT COUNT(*)::int AS n FROM resources WHERE external_source IS NOT NULL AND created_at > now() - interval '24 hours'`
  )
  if (all.rows[0].n >= TOTAL_PER_DAY) throw httpError(429, 'The library has reached its daily limit for external books')

  if (busy) throw httpError(429, 'Another book is being added right now. Try again in a minute.')
  busy = true

  const job = { id: crypto.randomUUID(), userId, state: 'working', resourceId: null, error: null, at: Date.now() }
  jobs.set(job.id, job)
  runImport(item, userId, job)
  return { jobId: job.id }
}

export function getJob(jobId, userId) {
  const job = jobs.get(jobId)
  if (!job || job.userId !== userId) return null
  return { state: job.state, resourceId: job.resourceId, error: job.error }
}
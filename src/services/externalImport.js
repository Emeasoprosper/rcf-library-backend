import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { query } from '../db/pool.js'
import { uploadToStorage, deleteFromStorage } from './storage.js'
import { resolveUploadCategory } from '../config/driveFolders.js'
import { queuePreviewGeneration } from './previewQueue.js'
import { getImportableItem } from './archiveSearch.js'
import { getImportableTextbook } from './openTextbooks.js'

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

// Downloads over IPv4 only (avoids the connect-timeout problem seen with Node's default
// connection method), follows redirects, and stops as soon as the size cap is passed.
function downloadOnce(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http:') ? http : https
    let deadline
    const req = client.get(url, { headers: UA, family: 4, timeout: 30000 }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        clearTimeout(deadline)
        res.resume()
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
        return resolve(downloadOnce(new URL(res.headers.location, url).toString(), redirectsLeft - 1))
      }
      if (status !== 200) {
        clearTimeout(deadline)
        res.resume()
        return reject(new Error(`The source returned ${status} for the file`))
      }
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) {
        clearTimeout(deadline)
        res.destroy()
        return reject(new Error('File is too large'))
      }
      const chunks = []
      let total = 0
      res.on('data', (chunk) => {
        total += chunk.length
        if (total > MAX_BYTES) {
          res.destroy(new Error('File is too large'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        clearTimeout(deadline)
        resolve(Buffer.concat(chunks))
      })
      res.on('error', (err) => {
        clearTimeout(deadline)
        reject(err)
      })
    })
    deadline = setTimeout(() => req.destroy(new Error('Download took too long')), 180000)
    req.on('timeout', () => req.destroy(new Error('Connection timed out')))
    req.on('error', (err) => {
      clearTimeout(deadline)
      reject(err)
    })
  })
}

async function downloadCapped(url) {
  let lastErr
  for (let i = 1; i <= 3; i++) {
    try {
      return await downloadOnce(url)
    } catch (err) {
      lastErr = err
      if (/too large/i.test(err.message)) throw err
      if (i < 3) await new Promise((r) => setTimeout(r, 3000))
    }
  }
  throw lastErr
}

async function runImport(item, userId, job) {
  let stored = null
  let inserted = false
  let step = 'download'
  try {
    const buffer = await downloadCapped(item.downloadUrl)
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Downloaded file is not a valid PDF')

    step = 'drive upload'
    const file = { originalname: safeFileName(item.title), mimetype: 'application/pdf', buffer, size: buffer.length }
    const driveCategory = resolveUploadCategory({ mimetype: 'application/pdf', resourceTypeSlug: 'book' })
    stored = await uploadToStorage(file, driveCategory)

    step = 'database'
    const typeResult = await query(`SELECT id FROM resource_types WHERE slug = 'book'`)
    if (typeResult.rows.length === 0) throw new Error('Book resource type is missing')

    const description =
      `Source: ${item.sourceName} (${item.sourceUrl}) · Licence: ${item.licence}` +
      `${item.year ? ` · Published ${item.year}` : ''}. Added on request through the RCF library.`

    const result = await query(
      `INSERT INTO resources (
         title, author, description, resource_type_id,
         storage_provider, file_id, file_url, file_name, file_type, file_size_bytes,
         uploaded_by, is_anonymous, thumbnail_status, status, reviewed_at,
         external_source, external_id, external_url, external_licence
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'application/pdf',$9,$10,true,'pending','approved',now(),
                 $11,$12,$13,$14)
       RETURNING id`,
      [
        item.title, item.author, description, typeResult.rows[0].id,
        stored.provider, stored.fileId, stored.fileUrl, file.originalname, buffer.length,
        userId, item.externalSource, item.identifier, item.sourceUrl, item.licence,
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
    const detail = [err.message, err.code, err.cause?.code].filter(Boolean).join(' | ')
    console.error(`External import failed for ${item.identifier} at step "${step}":`, detail)
    if (stored && !inserted) await deleteFromStorage(stored.fileId).catch(() => {})
    job.state = 'failed'
    job.error = `${step}: ${detail}`
  } finally {
    busy = false
  }
}

// Internet Archive book (public domain / open licence, re-checked here).
export async function startImport(identifier, userId) {
  const found = await getImportableItem(identifier)
  const encodedPath = found.pdfName.split('/').map(encodeURIComponent).join('/')
  return queueImport(
    {
      ...found,
      externalSource: 'internet_archive',
      sourceName: 'Internet Archive',
      downloadUrl: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodedPath}`,
    },
    userId
  )
}

// Open Textbook Library textbook (publisher's own open licence, re-checked here).
export async function startTextbookImport(textbookId, userId) {
  const found = await getImportableTextbook(textbookId)
  return queueImport({ ...found, externalSource: 'open_textbook_library', sourceName: 'Open Textbook Library' }, userId)
}

async function queueImport(item, userId) {
  for (const [id, job] of jobs) if (Date.now() - job.at > 60 * 60 * 1000) jobs.delete(id)

  const existing = await query(
    `SELECT id, status FROM resources WHERE external_source = $1 AND external_id = $2`,
    [item.externalSource, item.identifier]
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
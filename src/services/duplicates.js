import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { streamFromStorage } from './storage.js'

// One copy of each file in the library. Every file gets a fingerprint
// (SHA-256 of its bytes); an upload whose fingerprint matches a book that's
// in the library (live or waiting for review) is refused with a link to it.
// A deleted book's row is gone, so it can be uploaded again. A rejected one
// can be sent again too.
let ready = null
export function ensureFingerprints() {
  ready ||= query(`
    ALTER TABLE resources ADD COLUMN IF NOT EXISTS file_sha256 TEXT;
    CREATE INDEX IF NOT EXISTS idx_resources_sha256 ON resources (file_sha256) WHERE file_sha256 IS NOT NULL;
  `).catch((err) => {
    ready = null
    throw err
  })
  return ready
}

export const fingerprint = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

// Several photos sent as one upload: fingerprint of the photos themselves
// (the PDF made from them differs every time, it carries a date).
export function fingerprintAll(buffers) {
  if (buffers.length === 1) return fingerprint(buffers[0])
  const h = crypto.createHash('sha256')
  for (const b of buffers) h.update(fingerprint(b))
  return h.digest('hex')
}

// { id, title, status } of the copy already in the library, or null.
export async function findDuplicate(sha) {
  if (!sha) return null
  await ensureFingerprints()
  const r = await query(
    `SELECT id, title, status FROM resources WHERE file_sha256 = $1 AND status IN ('approved', 'pending')
     ORDER BY (status = 'approved') DESC, created_at LIMIT 1`,
    [sha]
  )
  return r.rows[0] || null
}

// Books added before fingerprints existed: worked through quietly in the
// background, one file at a time (streamed, so big files don't fill memory).
let backfilling = false
const skip = new Set()
export async function backfillFingerprints() {
  if (backfilling) return
  backfilling = true
  let done = 0
  try {
    await ensureFingerprints()
    for (;;) {
      const r = await query(
        `SELECT id, file_id FROM resources
         WHERE file_sha256 IS NULL AND file_id IS NOT NULL AND storage_provider = 'google_drive' AND NOT (id = ANY($1::uuid[]))
         ORDER BY created_at LIMIT 1`,
        [[...skip]]
      )
      const row = r.rows[0]
      if (!row) break
      try {
        const { data } = await streamFromStorage(row.file_id)
        const h = crypto.createHash('sha256')
        await new Promise((resolve, reject) => {
          data.on('data', (chunk) => h.update(chunk))
          data.on('end', resolve)
          data.on('error', reject)
        })
        await query(`UPDATE resources SET file_sha256 = $2 WHERE id = $1`, [row.id, h.digest('hex')])
        done += 1
      } catch (err) {
        skip.add(row.id)
        console.warn(`Fingerprint skipped for ${row.id}:`, err.message)
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    if (done) console.log(`Fingerprinted ${done} older library files`)
  } catch (err) {
    console.warn('Fingerprint backfill stopped:', err.message)
  } finally {
    backfilling = false
  }
}

export function startFingerprintBackfill() {
  setTimeout(backfillFingerprints, 60 * 1000) // after start-up settles
  setInterval(backfillFingerprints, 6 * 60 * 60 * 1000).unref?.()
}

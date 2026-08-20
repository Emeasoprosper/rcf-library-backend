// =========================================================
// Preview generation
// =========================================================
// PDF gets a REAL rendered preview of page 1 via pdfjs-dist + @napi-rs/canvas.
// Audio gets real embedded album art (via music-metadata) when present.
// Video gets a REAL first-frame extraction via ffmpeg-static + fluent-ffmpeg.
// DOC/DOCX and PPT/PPTX previews are still not implemented (needs
// LibreOffice on the host — see the stub function below). Those fall
// back to the generated cover card.
//
// Fire-and-forget in-process for now — under real load, swap to a real
// queue (BullMQ + Upstash Redis). Every path here is wrapped so a failure
// can never crash the server or hang the request — worst case a resource
// ends up with the generated cover instead of a real preview.
//
// NOTE: thumbnails are served through our own proxy route
// (GET /api/resources/:id/thumbnail) instead of a raw public Drive link,
// with Cross-Origin-Resource-Policy: cross-origin set in server.js so
// the frontend (different origin) can actually render them.
// =========================================================

import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { query } from '../db/pool.js'
import { uploadToStorage } from './storage.js'
import { generateCoverCard } from './coverGenerator.js'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

ffmpeg.setFfmpegPath(ffmpegPath)
ffmpeg.setFfprobePath(ffprobeStatic.path)

// On Windows, converting this to a plain path (e.g. via fileURLToPath)
// breaks it — Node's ESM loader refuses raw drive-letter paths like
// "C:\...", it requires an actual file:// URL. import.meta.resolve()
// already returns the correct file:// URL, so it's used as-is here.
GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')

// This one stays as a converted path (not a URL) — pdfjs-dist reads font
// data via the filesystem here, not a dynamic import, so a plain Windows
// path is what it actually expects for this specific option.
const STANDARD_FONT_DATA_URL = fileURLToPath(import.meta.resolve('pdfjs-dist/standard_fonts/')) + '/'

function buildThumbnailUrl(resourceId) {
  const base = (process.env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '')
  if (!base) {
    console.warn('PUBLIC_API_BASE_URL is not set in .env — thumbnails will not load correctly across origins.')
  }
  return `${base}/api/resources/${resourceId}/thumbnail`
}

export function queuePreviewGeneration(resourceId, storedFile, mimeType, fileBuffer, clientThumbnail = null) {
  generatePreview(resourceId, storedFile, mimeType, fileBuffer, clientThumbnail).catch((err) => {
    console.error(`Preview generation failed entirely for resource ${resourceId}:`, err)
    query(`UPDATE resources SET thumbnail_status = 'unavailable' WHERE id = $1`, [resourceId]).catch(() => {})
  })
}

async function generatePreview(resourceId, storedFile, mimeType, fileBuffer, clientThumbnail) {
  await query(`UPDATE resources SET thumbnail_status = 'processing' WHERE id = $1`, [resourceId])

  const metaResult = await query(
    `SELECT r.title, r.author, rt.slug AS type_slug, rt.label AS type_label
     FROM resources r JOIN resource_types rt ON rt.id = r.resource_type_id
     WHERE r.id = $1`,
    [resourceId]
  )
  const meta = metaResult.rows[0] || {}

  let result = null

  if (clientThumbnail?.fileId) {
    // A real thumbnail was already rendered client-side and uploaded
    // (currently: DOCX, via docxThumbnail.js). Use it directly instead
    // of attempting server-side generation, which is known to fail for
    // office formats (see previewFromOffice stub below) and would just
    // waste time before falling back anyway.
    result = { thumbnailFileId: clientThumbnail.fileId }
  } else {
    try {
      if (mimeType === 'application/pdf') {
        result = await previewFromPdf(fileBuffer)
      } else if (mimeType.startsWith('image/')) {
        // The uploaded image IS the thumbnail — no separate generation
        // needed, just point the proxy route at the original file.
        result = { thumbnailFileId: storedFile.fileId }
      } else if (mimeType.startsWith('video/')) {
        result = await previewFromVideo(fileBuffer)
      } else if (mimeType.startsWith('audio/')) {
        result = await previewFromAudio(fileBuffer)
      } else if (isWordOrPowerpoint(mimeType)) {
        result = await previewFromOffice(storedFile, mimeType)
      }
    } catch (err) {
      console.warn(`Real preview unavailable for resource ${resourceId} (${mimeType}): ${err.message} — using generated cover instead.`)
      result = null
    }
  }

  // PDF, video, and audio-with-artwork paths return a pngBuffer that
  // still needs uploading; the image path already returned a usable
  // thumbnailFileId; everything else is null at this point.
  if (result?.pngBuffer) {
    try {
      const uploaded = await uploadToStorage(
        { originalname: `${resourceId}-preview.png`, mimetype: 'image/png', buffer: result.pngBuffer },
        'img'
      )
      result.thumbnailFileId = uploaded.fileId
    } catch (err) {
      console.error(`Failed to upload rendered preview for resource ${resourceId}:`, err)
      result = null
    }
  }

  if (!result?.thumbnailFileId) {
    try {
      const pngBuffer = await generateCoverCard({
        title: meta.title,
        author: meta.author,
        typeSlug: meta.type_slug,
        typeLabel: meta.type_label,
      })
      const uploaded = await uploadToStorage(
        { originalname: `${resourceId}-cover.png`, mimetype: 'image/png', buffer: pngBuffer },
        'img'
      )
      result = { ...result, thumbnailFileId: uploaded.fileId }
    } catch (err) {
      console.error(`Cover generation failed for resource ${resourceId}:`, err)
    }
  }

  if (result?.thumbnailFileId) {
    await query(
      `UPDATE resources SET thumbnail_url = $1, thumbnail_file_id = $2, thumbnail_status = 'ready',
              page_count = COALESCE($3, page_count),
              duration_seconds = COALESCE($4, duration_seconds),
              width_px = COALESCE($5, width_px),
              height_px = COALESCE($6, height_px),
              est_reading_min = COALESCE($7, est_reading_min),
              est_listening_min = COALESCE($8, est_listening_min),
              est_watching_min = COALESCE($9, est_watching_min)
       WHERE id = $10`,
      [
        buildThumbnailUrl(resourceId), result.thumbnailFileId,
        result.pageCount || null, result.durationSeconds || null,
        result.widthPx || null, result.heightPx || null,
        result.pageCount ? Math.max(1, Math.round(result.pageCount * 1.5)) : null,
        result.durationSeconds ? Math.round(result.durationSeconds / 60) : null,
        result.durationSeconds && mimeType.startsWith('video/') ? Math.round(result.durationSeconds / 60) : null,
        resourceId,
      ]
    )
  } else {
    await query(`UPDATE resources SET thumbnail_status = 'unavailable' WHERE id = $1`, [resourceId])
  }
}

function isWordOrPowerpoint(mimeType) {
  return [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ].includes(mimeType)
}

// --- REAL implementation, tested end-to-end with actual rendered output. ---
async function previewFromPdf(buffer) {
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise

  const page = await pdf.getPage(1)
  const unscaled = page.getViewport({ scale: 1 })
  const targetWidth = 800
  const scale = targetWidth / unscaled.width
  const viewport = page.getViewport({ scale })

  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height))
  const context = canvas.getContext('2d')
  await page.render({ canvasContext: context, viewport }).promise

  return {
    pngBuffer: canvas.toBuffer('image/png'),
    pageCount: pdf.numPages,
    widthPx: Math.round(viewport.width),
    heightPx: Math.round(viewport.height),
  }
}

// --- REAL implementation: embedded album art + duration, no ffmpeg needed. ---
async function previewFromAudio(buffer) {
  const { parseBuffer } = await import('music-metadata')
  const metadata = await parseBuffer(buffer)

  const durationSeconds = metadata.format.duration
    ? Math.round(metadata.format.duration)
    : null

  const embeddedArt = metadata.common.picture?.[0]
  if (!embeddedArt) {
    // No embedded album art — fall through to the generated cover card.
    return { durationSeconds }
  }

  const sharp = (await import('sharp')).default
  const pngBuffer = await sharp(embeddedArt.data).png().toBuffer()

  return { pngBuffer, durationSeconds }
}

// Picks candidate seek points spread across the clip, ordered from most
// to least preferred: 10% in first (usually clear of any intro), then
// 25%, 45%, 65%. Each is floored at 1s and kept below the clip's end so
// a short video never asks ffmpeg to seek past its own duration.
function buildCandidateSeeks(durationSeconds) {
  const duration = durationSeconds && isFinite(durationSeconds) ? durationSeconds : 4
  const fractions = [0.10, 0.25, 0.45, 0.65]
  const seen = new Set()
  const seeks = []
  for (const f of fractions) {
    const t = Math.min(Math.max(duration * f, 1), Math.max(duration - 0.5, 1))
    const rounded = Math.round(t * 10) / 10
    if (!seen.has(rounded)) {
      seen.add(rounded)
      seeks.push(rounded)
    }
  }
  return seeks
}

// A frame is "too dark to use" if its average channel brightness is
// near black — catches loading screens, fade-ins, and blank desktop
// moments that a fixed seek point can land on. 255 = white, 0 = black;
// 18 is a conservative floor (a genuinely dark-but-visible frame, e.g.
// a dim lecture hall, still averages well above this).
const DARK_FRAME_THRESHOLD = 18

async function isFrameTooDark(pngBuffer) {
  const sharp = (await import('sharp')).default
  const stats = await sharp(pngBuffer).stats()
  const avgBrightness =
    stats.channels.slice(0, 3).reduce((sum, ch) => sum + ch.mean, 0) / Math.min(3, stats.channels.length)
  return avgBrightness < DARK_FRAME_THRESHOLD
}

function extractFrameAt(inputPath, outputPath, seekSeconds) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .on('end', resolve)
      .on('error', reject)
      .screenshots({
        timestamps: [seekSeconds],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: '800x?',
      })
  })
}

// --- REAL implementation: first-frame extraction via ffmpeg-static. ---
// fluent-ffmpeg needs real files on disk (not buffers), so this writes
// the upload to a temp file, then tries a handful of seek points
// (see buildCandidateSeeks) until one produces a frame that isn't just
// black — screen recordings very often open on a loading screen or
// blank desktop, so a single fixed seek point kept grabbing black. Each
// attempt overwrites the same temp output file; if every candidate
// comes back dark, the last attempted frame is used anyway (still
// better than failing the whole preview and losing duration/dimensions
// too) — always cleans up both temp files, even on failure.
async function previewFromVideo(buffer) {
  const tempDir = os.tmpdir()
  const inputPath = path.join(tempDir, `${randomUUID()}-input.mp4`)
  const outputPath = path.join(tempDir, `${randomUUID()}-frame.png`)

  await fs.writeFile(inputPath, buffer)

  try {
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, data) => (err ? reject(err) : resolve(data)))
    })

    const durationSeconds = metadata.format?.duration
      ? Math.round(metadata.format.duration)
      : null
    const videoStream = metadata.streams?.find((s) => s.codec_type === 'video')
    const widthPx = videoStream?.width || null
    const heightPx = videoStream?.height || null

    const candidateSeeks = buildCandidateSeeks(durationSeconds)

    let pngBuffer = null
    for (const seek of candidateSeeks) {
      await extractFrameAt(inputPath, outputPath, seek)
      const attemptBuffer = await fs.readFile(outputPath)
      pngBuffer = attemptBuffer // always keep the latest as a fallback
      const tooDark = await isFrameTooDark(attemptBuffer)
      if (!tooDark) break
    }

    return { pngBuffer, durationSeconds, widthPx, heightPx }
  } finally {
    await fs.unlink(inputPath).catch(() => {})
    await fs.unlink(outputPath).catch(() => {})
  }
}

// --- Still a stub — needs LibreOffice on the host, not available here. ---
async function previewFromOffice(storedFile, mimeType) {
  throw new Error('previewFromOffice not yet implemented (requires LibreOffice on host)')
}
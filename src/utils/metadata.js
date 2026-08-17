import sharp from 'sharp'
import { createRequire } from 'node:module'

// pdf-parse is a CommonJS package whose export doesn't reliably map to
// ESM's `default` import under Node — createRequire loads it the
// CommonJS way instead, which sidesteps that interop error entirely.
const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')

// Cheap, synchronous metadata that's fine to compute during the upload
// request itself. Anything requiring page-rendering or external binaries
// (PDF page count for display, video duration, DOCX conversion) happens
// in the async preview job instead — see services/previewQueue.js.
//
// detectedAuthor/detectedTitle are best-effort only — used as a fallback
// when the uploader left those fields blank, never to overwrite what they
// typed. See routes/uploads.js for how the fallback is applied.
export async function extractBasicMetadata(file) {
  if (file.mimetype.startsWith('image/')) {
    try {
      const meta = await sharp(file.buffer).metadata()
      return {
        widthPx: meta.width || null,
        heightPx: meta.height || null,
        aspectRatio: meta.width && meta.height ? simplifyRatio(meta.width, meta.height) : null,
        detectedAuthor: null,
        detectedTitle: null,
      }
    } catch {
      return { widthPx: null, heightPx: null, aspectRatio: null, detectedAuthor: null, detectedTitle: null }
    }
  }

  if (file.mimetype === 'application/pdf') {
    const fromFilename = parseAuthorFromFilename(file.originalname)
    try {
      const parsed = await pdfParse(file.buffer, { max: 1 }) // only parse page 1 — we just need the Info dict, not full text
      const info = parsed.info || {}
      return {
        widthPx: null,
        heightPx: null,
        aspectRatio: null,
        // PDF Info.Author is often blank or set to software name ("Microsoft
        // Word") rather than a real person — filename pattern is frequently
        // more reliable for academic PDFs shared as "Author - Title.pdf",
        // so prefer that when both are present.
        detectedAuthor: fromFilename.author || cleanPdfField(info.Author) || null,
        detectedTitle: fromFilename.title || cleanPdfField(info.Title) || null,
      }
    } catch {
      return {
        widthPx: null,
        heightPx: null,
        aspectRatio: null,
        detectedAuthor: fromFilename.author || null,
        detectedTitle: fromFilename.title || null,
      }
    }
  }

  // Non-PDF, non-image documents (doc/docx/ppt/pptx etc.) — filename
  // pattern is the only signal we have without a heavier parsing library.
  const fromFilename = parseAuthorFromFilename(file.originalname)
  return {
    widthPx: null,
    heightPx: null,
    aspectRatio: null,
    detectedAuthor: fromFilename.author || null,
    detectedTitle: fromFilename.title || null,
  }
}

// Matches "Author Name - Title.ext" or "Author Name — Title.ext".
// Anything without that separator returns no detected author (safer than
// guessing wrong on a filename like "CHM201_notes_final_v2.pdf").
function parseAuthorFromFilename(originalname) {
  const withoutExt = originalname.replace(/\.[^./\\]+$/, '')
  const match = withoutExt.match(/^(.+?)\s*[-–—]\s*(.+)$/)
  if (!match) return { author: null, title: null }
  return { author: match[1].trim(), title: match[2].trim() }
}

// Strips common placeholder values PDF generators leave behind that aren't
// actually a person's name.
function cleanPdfField(value) {
  if (!value) return null
  const trimmed = value.trim()
  const junkValues = ['', 'unknown', 'user', 'admin', 'microsoft word', 'microsoft office user']
  if (junkValues.includes(trimmed.toLowerCase())) return null
  return trimmed
}

function simplifyRatio(w, h) {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(w, h)
  return `${w / divisor}:${h / divisor}`
}
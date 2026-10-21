// rcf-library-backend/src/services/textExtraction.js
// Full-text extraction for the Reading Space / AI features. Uses
// pdfjs-dist (already proven in previewQueue.js), NOT pdf-parse.
// Scanned/image-only files are flagged 'needs_ocr' for Phase 2.
import { fileURLToPath } from 'node:url'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { query } from '../db/pool.js'
import { downloadFromStorage, convertOfficeFileToPdf } from './storage.js'

// Same values previewQueue.js uses (must stay a file:// URL for the worker).
GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
const STANDARD_FONT_DATA_URL = fileURLToPath(import.meta.resolve('pdfjs-dist/standard_fonts/')) + '/'

const MAX_PAGES = 400
const MAX_CHARS = 600000
const MIN_CHARS_PER_PAGE = 40 // below this average, the PDF is almost certainly scanned

const OFFICE_MIME_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const OCR_MAX_PAGES = 30
const OCR_MAX_BYTES = 15 * 1024 * 1024
const OCR_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'

// Reads scanned PDFs and images with Gemini. Returns text, or null if it
// can't (no key, file too big, AI error) so the file stays 'needs_ocr'.
async function ocrWithGemini(buffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null
  const bytes = Buffer.from(buffer)
  if (bytes.length > OCR_MAX_BYTES) return null

  const instruction =
    mimeType === 'application/pdf'
      ? 'Transcribe all text in this document exactly as written, including handwriting and text inside images or diagrams. Start every page with a line "--- page N ---" (N = page number) followed by that page\'s text. Output only the transcription.'
      : 'Transcribe all text in this image exactly as written. Output only the transcription.'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${OCR_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { parts: [{ inline_data: { mime_type: mimeType, data: bytes.toString('base64') } }, { text: instruction }] },
          ],
          generationConfig: { temperature: 0 },
        }),
        signal: controller.signal,
      }
    )
    if (!response.ok) return null
    const data = await response.json()
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim()
    return text.length >= MIN_CHARS_PER_PAGE ? text : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function extractPdfText(buffer) {
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise

  try {
    const pageCount = pdf.numPages
    const limit = Math.min(pageCount, MAX_PAGES)
    const chunks = []
    let rawChars = 0
    let pagesExtracted = 0

    for (let p = 1; p <= limit; p += 1) {
      const page = await pdf.getPage(p)
      const textContent = await page.getTextContent()
      const text = textContent.items
        .map((item) => item.str || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      page.cleanup()
      chunks.push(`--- page ${p} ---\n${text}`)
      rawChars += text.length
      pagesExtracted = p
      if (rawChars >= MAX_CHARS) break
    }

    return { text: chunks.join('\n\n'), pageCount, pagesExtracted, rawChars }
  } finally {
    await pdf.destroy().catch(() => {})
  }
}

// Returns the final status: 'ready' | 'needs_ocr' | 'unsupported' | 'failed'
export async function extractResourceText(resource) {
  const { id, file_id: fileId, file_type: mimeType } = resource
  let result

  try {
    if (mimeType === 'application/pdf' || OFFICE_MIME_TYPES.has(mimeType)) {
      const pdfBuffer =
        mimeType === 'application/pdf'
          ? await downloadFromStorage(fileId)
          : await convertOfficeFileToPdf(fileId, mimeType)
      const out = await extractPdfText(pdfBuffer)
      const avg = out.pagesExtracted ? out.rawChars / out.pagesExtracted : 0
      result = {
        content: out.text,
        pageCount: out.pageCount,
        pagesExtracted: out.pagesExtracted,
        status: avg >= MIN_CHARS_PER_PAGE ? 'ready' : 'needs_ocr',
        error: null,
      }
      if (result.status === 'needs_ocr' && out.pageCount <= OCR_MAX_PAGES) {
        const scanned = await ocrWithGemini(pdfBuffer, 'application/pdf')
        if (scanned) result = { ...result, content: scanned, pagesExtracted: out.pageCount, status: 'ready' }
      }
    } else if (mimeType && mimeType.startsWith('image/')) {
      const scanned = await ocrWithGemini(await downloadFromStorage(fileId), mimeType)
      result = scanned
        ? { content: `--- page 1 ---\n${scanned}`, pageCount: 1, pagesExtracted: 1, status: 'ready', error: null }
        : { content: '', pageCount: 1, pagesExtracted: 0, status: 'needs_ocr', error: null }
    } else {
      result = { content: '', pageCount: null, pagesExtracted: 0, status: 'unsupported', error: null }
    }
  } catch (err) {
    result = { content: '', pageCount: null, pagesExtracted: 0, status: 'failed', error: String(err.message || err).slice(0, 300) }
  }

  // Postgres TEXT cannot hold NUL characters, and some PDFs contain them.
  const content = result.content.replace(/\u0000/g, '')

  await query(
    `INSERT INTO resource_text (resource_id, content, char_count, page_count, pages_extracted, status, error, extracted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (resource_id) DO UPDATE SET
       content = EXCLUDED.content, char_count = EXCLUDED.char_count,
       page_count = EXCLUDED.page_count, pages_extracted = EXCLUDED.pages_extracted,
       status = EXCLUDED.status, error = EXCLUDED.error, extracted_at = now()`,
    [id, content, content.length, result.pageCount, result.pagesExtracted, result.status, result.error]
  )

  return result.status
}
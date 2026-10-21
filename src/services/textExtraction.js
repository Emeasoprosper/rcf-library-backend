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
    } else if (mimeType && mimeType.startsWith('image/')) {
      result = { content: '', pageCount: 1, pagesExtracted: 0, status: 'needs_ocr', error: null }
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
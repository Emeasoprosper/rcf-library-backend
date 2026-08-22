// rcf-library-backend/src/services/aiAnalysis.js
import { query } from '../db/pool.js'
import { normalizeCourseCode } from '../utils/courseCode.js'

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

// Keeps the request small/cheap and within the free tier's per-minute
// token budget — a few thousand characters is plenty for a model to infer
// title/author/course/category/tags from.
const MAX_EXTRACTED_TEXT_CHARS = 6000

// File types we currently know how to analyze. Audio/video/zip are
// intentionally excluded for now — feeding audio/video content to the
// model would multiply cost and isn't needed for the primary use case
// (books, notes, papers, past questions). Uploaders of those types just
// get the existing manual-entry flow, same as before this feature.
const SUPPORTED_ANALYSIS_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg', 'image/png', 'image/webp',
])

function buildPrompt({ resourceTypeSlug, existingCategories }) {
  return `You are helping catalog an academic resource for a Nigerian university (MOUAU) digital library.
Look at the provided document content and return ONLY a single JSON object (no markdown, no commentary, no code fences) with exactly these keys:

{
  "title": string or null,
  "author": string or null,
  "courseCode": string or null,
  "description": string or null,
  "categorySuggestion": string or null,
  "tags": string[],
  "chapterOrPart": string or null
}

Guidance for each field:
- courseCode: only if the document clearly states or is clearly about one specific course (e.g. "CSC 415"). Otherwise null.
- description: 1-2 sentences, factual, based only on what's actually in the content. Use null if you aren't confident — never fabricate a plausible-sounding summary.
- categorySuggestion: pick the closest fit from this existing list if one genuinely fits: ${existingCategories.length ? existingCategories.join(', ') : '(none yet)'}. If nothing fits well, propose a short new category name instead of forcing a bad match.
- tags: up to 6 short topical keywords, lowercase, no duplicates of the category.
- chapterOrPart: e.g. "Chapter 3" or "Part 1" — only if this file is clearly one piece of a larger multi-part work (a book chapter, a lecture series part). Otherwise null.

Resource type as classified by the uploader: ${resourceTypeSlug || 'unknown'}.
Never invent course codes, author names, or any MOUAU-specific facts you cannot actually see in the content. When unsure, use null rather than guessing.`
}

async function callGemini(parts, prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured')

  const body = {
    contents: [{ parts: [{ text: prompt }, ...parts] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  }

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`Gemini request failed (${response.status}): ${errText.slice(0, 300)}`)
  }

  const data = await response.json()
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!rawText) throw new Error('Gemini returned no content')

  try {
    return JSON.parse(rawText)
  } catch {
    throw new Error('Gemini returned non-JSON output')
  }
}

// The ONLY source of truth for course → department/college/level. Called
// both here (for the analyze preview) and from routes/uploads.js at
// actual submit time, so a course match always wins over whatever the AI
// or the client sent — satisfies "do not allow AI to invent MOUAU course
// information."
export async function lookupCourse(rawCode) {
  const normalized = normalizeCourseCode(rawCode)
  if (!normalized) {
    return { code: null, found: false, title: null, departmentId: null, departmentName: null, level: null }
  }

  const result = await query(
    `SELECT c.code, c.title, c.level, c.department_id, d.name AS department_name
     FROM courses c
     LEFT JOIN departments d ON d.id = c.department_id
     WHERE c.code = $1`,
    [normalized]
  )

  if (result.rows.length === 0) {
    return { code: normalized, found: false, title: null, departmentId: null, departmentName: null, level: null }
  }

  const row = result.rows[0]
  return {
    code: row.code,
    found: true,
    title: row.title,
    departmentId: row.department_id,
    departmentName: row.department_name,
    level: row.level,
  }
}

async function matchCategory(suggestionName) {
  const trimmed = (suggestionName || '').trim()
  if (!trimmed) return { categoryId: null, categoryName: null, isNew: false }

  const existing = await query(`SELECT id, name FROM categories WHERE name ILIKE $1`, [trimmed])
  if (existing.rows.length > 0) {
    return { categoryId: existing.rows[0].id, categoryName: existing.rows[0].name, isNew: false }
  }
  return { categoryId: null, categoryName: trimmed, isNew: true }
}

// Returns null when there's nothing useful to suggest (AI unavailable,
// unsupported file type, or the model call itself failed) — callers treat
// null as "fall back to manual entry," never as an error condition.
export async function analyzeResourceFile({ buffer, mimetype, extractedText, resourceTypeSlug, existingCategories = [], filenameTitle = null }) {
  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set — skipping AI analysis, manual entry only.')
    return filenameTitle ? { title: filenameTitle, author: null, description: null, tags: [], chapterOrPart: null, course: await lookupCourse(null), category: { categoryId: null, categoryName: null, isNew: false } } : null
  }
  if (!SUPPORTED_ANALYSIS_MIME_TYPES.has(mimetype)) {
    return filenameTitle ? { title: filenameTitle, author: null, description: null, tags: [], chapterOrPart: null, course: await lookupCourse(null), category: { categoryId: null, categoryName: null, isNew: false } } : null
  }

  const isImage = mimetype.startsWith('image/')
  const parts = []

  if (isImage) {
    parts.push({ inlineData: { mimeType: mimetype, data: buffer.toString('base64') } })
  } else if (extractedText) {
    parts.push({ text: extractedText.slice(0, MAX_EXTRACTED_TEXT_CHARS) })
  } else {
    // Non-image, no extractable text (e.g. a scanned/image-only PDF, or
    // a .doc/.ppt we don't parse client-side) — nothing for Gemini to
    // read, but the filename is still a real signal worth using rather
    // than leaving the title blank.
    return filenameTitle
      ? { title: filenameTitle, author: null, description: null, tags: [], chapterOrPart: null, course: await lookupCourse(null), category: { categoryId: null, categoryName: null, isNew: false } }
      : null
  }

  const prompt = buildPrompt({ resourceTypeSlug, existingCategories })

  let aiResult
  try {
    aiResult = await callGemini(parts, prompt)
  } catch (err) {
    console.error('AI analysis failed, falling back to manual entry:', err.message)
    return null
  }

  const [course, category] = await Promise.all([
    lookupCourse(aiResult.courseCode),
    matchCategory(aiResult.categorySuggestion),
  ])

  return {
    title: aiResult.title || null,
    author: aiResult.author || null,
    description: aiResult.description || null,
    tags: Array.isArray(aiResult.tags) ? aiResult.tags.slice(0, 6).map((t) => String(t).trim()).filter(Boolean) : [],
    chapterOrPart: aiResult.chapterOrPart || null,
    course,   // { code, found, title, departmentId, departmentName, level }
    category, // { categoryId, categoryName, isNew }
  }
}
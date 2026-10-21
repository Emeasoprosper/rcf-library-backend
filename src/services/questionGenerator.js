// rcf-library-backend/src/services/questionGenerator.js
import { query } from '../db/pool.js'
import { extractResourceText } from './textExtraction.js'

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

const MAX_SOURCE_CHARS = 24000
const MAX_STYLE_CHARS = 4000

export const MODE_DEFAULTS = {
  practice: { label: 'Practice', count: 10, minutesPerQuestion: null, mix: '70% multiple choice, 30% short answer' },
  cat: { label: 'CAT', count: 15, minutesPerQuestion: 1.5, mix: '80% multiple choice, 20% short answer' },
  exam: { label: 'Exam', count: 25, minutesPerQuestion: 2, mix: '50% multiple choice, 30% short answer, 20% theory (essay)' },
}

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

async function fetchResourceTextRow(resourceId) {
  const result = await query(
    `SELECT r.title, r.course_code, r.file_id, r.file_type, t.content, t.status
     FROM resources r
     LEFT JOIN resource_text t ON t.resource_id = r.id
     WHERE r.id = $1 AND r.status = 'approved'`,
    [resourceId]
  )
  return result.rows[0] || null
}

async function loadResourceText(resourceId) {
  let row = await fetchResourceTextRow(resourceId)
  if (!row) throw httpError(404, 'Resource not found')

  // Not extracted yet (backfill hasn't reached it): do it now, once.
  if (!row.status) {
    await extractResourceText({ id: resourceId, file_id: row.file_id, file_type: row.file_type })
    row = await fetchResourceTextRow(resourceId)
  }

  if (row.status !== 'ready') {
    throw httpError(
      400,
      row.status === 'needs_ocr'
        ? 'This file looks scanned or handwritten, so there is no text to build questions from yet.'
        : 'Questions cannot be generated from this kind of file yet.'
    )
  }
  return row
}

function splitPages(content) {
  const marks = [...content.matchAll(/--- page (\d+) ---\n/g)]
  const pages = []
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].index + marks[i][0].length
    const end = i + 1 < marks.length ? marks[i + 1].index : content.length
    pages.push({ page: Number(marks[i][1]), text: content.slice(start, end).trim() })
  }
  return pages
}

function pickSource(pages, pageFrom, pageTo) {
  let pool = pages.filter((p) => p.text)
  const ranged = Boolean(pageFrom || pageTo)
  if (ranged) pool = pool.filter((p) => (!pageFrom || p.page >= pageFrom) && (!pageTo || p.page <= pageTo))
  if (pool.length === 0) return null

  const totalChars = pool.reduce((sum, p) => sum + p.text.length, 0)
  let chosen = pool

  if (totalChars > MAX_SOURCE_CHARS) {
    if (ranged) {
      chosen = []
      let used = 0
      for (const p of pool) {
        if (used + p.text.length > MAX_SOURCE_CHARS) break
        chosen.push(p)
        used += p.text.length
      }
      if (chosen.length === 0) chosen = [{ page: pool[0].page, text: pool[0].text.slice(0, MAX_SOURCE_CHARS) }]
    } else {
      // Whole book: sample pages spread evenly so questions cover it all.
      const avg = totalChars / pool.length
      const n = Math.max(1, Math.floor(MAX_SOURCE_CHARS / avg))
      const step = pool.length / n
      chosen = Array.from({ length: n }, (_, i) => pool[Math.floor(i * step)])
    }
  }

  return {
    text: chosen.map((p) => `[page ${p.page}]\n${p.text}`).join('\n\n').slice(0, MAX_SOURCE_CHARS),
    firstPage: chosen[0].page,
    lastPage: chosen[chosen.length - 1].page,
  }
}

// If the library has a past-question file for the same course, borrow its
// STYLE (wording, difficulty, format) — never its questions.
async function loadStyleReference(resourceId, courseCode) {
  if (!courseCode) return null
  const result = await query(
    `SELECT t.content
     FROM resources r
     JOIN resource_types rt ON rt.id = r.resource_type_id
     JOIN resource_text t ON t.resource_id = r.id AND t.status = 'ready'
     WHERE rt.slug = 'past_question' AND r.status = 'approved'
       AND r.course_code = $1 AND r.id <> $2
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [courseCode, resourceId]
  )
  const content = result.rows[0]?.content
  if (!content) return null
  return content.replace(/--- page \d+ ---\n/g, '').slice(0, MAX_STYLE_CHARS)
}

function buildPrompt({ count, difficulty, mode, source, styleReference }) {
  const cfg = MODE_DEFAULTS[mode]
  return `You are an examiner at a Nigerian university (MOUAU). Write ${count} ${difficulty} questions in "${cfg.label}" style using ONLY the study material below.
Question mix: ${cfg.mix}.

Rules:
- Base every question strictly on the material. Never use outside facts or invent details.
- Multiple choice: exactly 4 options, one correct. "answer" is only the letter A, B, C or D. Do not put letters inside the option text.
- Short answer: "answer" is a concise model answer (1-3 sentences).
- Theory: "answer" is a model answer outline (3-6 sentences).
- "explanation": one sentence on why the answer is correct.
- No two questions may test the same fact.
${styleReference ? `\nPAST QUESTIONS FOR THIS COURSE (copy only the style, wording and difficulty. Do NOT reuse these questions):\n${styleReference}\n` : ''}
Return ONLY a JSON object, no markdown:
{"title": string, "questions": [{"kind": "mcq" | "short" | "theory", "prompt": string, "options": [string, string, string, string] or null, "answer": string, "explanation": string}]}

STUDY MATERIAL:
${source}`
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw httpError(503, 'AI is not configured on the server.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  let response
  try {
    response = await fetch(`${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      }),
      signal: controller.signal,
    })
  } catch {
    throw httpError(504, 'The AI took too long. Try fewer questions.')
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    console.error(`Gemini question generation failed (${response.status}):`, errText.slice(0, 300))
    throw httpError(502, 'The AI is busy right now. Try again in a minute.')
  }

  const data = await response.json()
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!rawText) throw httpError(502, 'The AI returned nothing. Try again.')
  try {
    return JSON.parse(rawText)
  } catch {
    throw httpError(502, 'The AI returned a bad response. Try again.')
  }
}

function cleanQuestions(raw, count) {
  const list = Array.isArray(raw?.questions) ? raw.questions : []
  const out = []
  for (const q of list) {
    const kind = ['mcq', 'short', 'theory'].includes(q?.kind) ? q.kind : null
    const prompt = String(q?.prompt || '').trim()
    const answer = String(q?.answer || '').trim()
    if (!kind || !prompt || !answer) continue
    const explanation = String(q?.explanation || '').trim()

    if (kind === 'mcq') {
      const options = Array.isArray(q.options)
        ? q.options.map((o) => String(o).replace(/^[A-D][).:]\s+/i, '').trim()).filter(Boolean)
        : []
      const letter = answer.toUpperCase().match(/^([A-D])(?![A-Z])/)?.[1]
      if (options.length !== 4 || !letter) continue
      out.push({ kind, prompt, options, answer: letter, explanation })
    } else {
      out.push({ kind, prompt, options: null, answer, explanation })
    }
    if (out.length >= count) break
  }
  return out
}

export async function generateQuestions({ resourceId, mode, difficulty, count, pageFrom, pageTo }) {
  const row = await loadResourceText(resourceId)
  const pages = splitPages(row.content)
  const picked = pickSource(pages, pageFrom, pageTo)
  if (!picked) throw httpError(400, 'No readable text was found in that page range.')

  const styleReference = await loadStyleReference(resourceId, row.course_code)
  const raw = await callGemini(buildPrompt({ count, difficulty, mode, source: picked.text, styleReference }))
  const questions = cleanQuestions(raw, count)
  if (questions.length < 3) throw httpError(502, 'The AI did not return usable questions. Try again.')

  return {
    resourceTitle: row.title,
    questions,
    pagesUsed: { from: picked.firstPage, to: picked.lastPage },
    usedStyleReference: Boolean(styleReference),
  }
}
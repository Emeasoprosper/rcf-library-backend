// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/noteGenerator.js
// Writes comprehensive lecture notes for a course, in stages, so even a free
// model produces long, careful notes instead of one rushed answer:
//   1. research  - looks the course up on the web (Google Search grounding on
//                  Gemini, web search on Claude) and plans it: description,
//                  objectives, a 12-14 week scheme of work, references
//   2. chapters  - one call per week, each a full teaching chapter
//   3. revision  - summary, glossary and revision questions with answers
//
// Provider: Claude when ANTHROPIC_API_KEY is set (best quality, paid);
// otherwise Gemini's free tier, trying the strongest model that answers.
import Anthropic from '@anthropic-ai/sdk'

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
// Strongest first. Models that don't exist (or aren't free) for this key are
// skipped automatically, and the one that worked is remembered.
const GEMINI_CANDIDATES = [
  process.env.NOTES_GEMINI_MODEL,
  'gemini-3.5-pro',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
].filter((m, i, all) => m && all.indexOf(m) === i)
const CLAUDE_MODEL = process.env.NOTES_CLAUDE_MODEL || 'claude-opus-5-5'

export function notesProvider() {
  if (process.env.ANTHROPIC_API_KEY) return { name: 'claude', model: CLAUDE_MODEL }
  if (GEMINI_API_KEY) return { name: 'gemini', model: workingGemini.default || GEMINI_CANDIDATES[0] }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- Gemini ----------
const workingGemini = {} // 'search' | 'default' -> model name that answered

async function geminiOnce(model, { system, prompt, search, maxTokens }) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
        ...(search ? { tools: [{ google_search: {} }] } : {}),
      }),
      signal: AbortSignal.timeout(240000),
    }
  )
  if (!res.ok) {
    const err = new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const data = await res.json()
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim()
  if (!text) throw Object.assign(new Error(`Gemini ${model} returned no text (${data.candidates?.[0]?.finishReason || 'unknown'})`), { status: 502 })
  return text
}

async function askGemini(opts) {
  const slot = opts.search ? 'search' : 'default'
  const order = workingGemini[slot] ? [workingGemini[slot], ...GEMINI_CANDIDATES.filter((m) => m !== workingGemini[slot])] : GEMINI_CANDIDATES
  let lastErr
  for (const model of order) {
    // Free-tier limits: back off and retry the same model a few times first.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const text = await geminiOnce(model, opts)
        workingGemini[slot] = model
        return { text, model }
      } catch (err) {
        lastErr = err
        if (err.status === 429 || err.status >= 500) {
          await sleep([20000, 45000, 90000, 150000][attempt])
          continue
        }
        break // 400/403/404: this model isn't usable for this key, try the next one
      }
    }
  }
  throw lastErr || new Error('No Gemini model answered')
}

// ---------- Claude ----------
let claudeClient = null
async function askClaude({ system, prompt, search, maxTokens }) {
  claudeClient ||= new Anthropic()
  const tools = search ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }] : undefined
  let messages = [{ role: 'user', content: prompt }]
  // Web search can pause a long turn; resume it (bounded).
  for (let i = 0; i < 5; i += 1) {
    const msg = await claudeClient.beta.messages
      .stream({
        model: CLAUDE_MODEL,
        max_tokens: Math.max(maxTokens, 16000),
        system,
        messages,
        ...(tools ? { tools } : {}),
        output_config: { effort: 'high' },
        // If a safety check declines, the API re-runs on a fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
      .finalMessage()
    if (msg.stop_reason === 'pause_turn') {
      messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: msg.content }]
      continue
    }
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined to write this section')
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
    if (!text) throw new Error('Claude returned no text')
    return { text, model: msg.model }
  }
  throw new Error('Claude kept pausing; gave up')
}

function ask(opts) {
  const provider = notesProvider()
  if (!provider) throw new Error('No AI key configured (set GEMINI_API_KEY, or ANTHROPIC_API_KEY for Claude)')
  return provider.name === 'claude' ? askClaude(opts) : askGemini(opts)
}

// ---------- Prompts ----------
const TEACHER = `You are an experienced lecturer at a Nigerian university and an outstanding teacher. You write lecture notes for undergraduates at Michael Okpara University of Agriculture, Umudike (MOUAU), following the NUC CCMAS curriculum.

Your notes must be:
- Accurate and complete: cover the topic as a good lecturer would over a full week of classes.
- Easy to understand: plain English, short paragraphs, every technical term defined the first time it appears, ideas built step by step from simple to advanced.
- Practical: worked examples solved step by step, real-life and Nigerian/African examples where they fit naturally.

Formatting rules (the notes are printed as a PDF, so follow them exactly):
- Use Markdown only: ### for section headings, #### for sub-headings, - for bullet points, 1. for numbered steps, **bold** for key terms, and pipe tables (| a | b |) for comparisons.
- Write maths in plain text, e.g. x^2 + 3x - 4 = 0, sqrt(b^2 - 4ac), (a + b)/2, sum of x from i = 1 to n. Never use LaTeX, $ signs or HTML.
- No emojis. Do not include links or citation markers like [1].
- Start directly with the content. No greetings, no "Sure, here are…", no closing remarks.`

function cleanText(s) {
  return String(s || '')
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '') // citation markers
    .replace(/\$\$?([^$]+)\$\$?/g, '$1') // stray LaTeX delimiters
    .replace(/\\\(|\\\)|\\\[|\\\]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function parseJsonBlock(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const raw = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  return JSON.parse(raw)
}

async function planCourse({ courseCode, title, level, department }) {
  const what = [courseCode, title].filter(Boolean).join(' – ')
  const prompt = `Research the university course "${what}"${level ? ` (${level} level)` : ''}${department ? ` in the Department of ${department}` : ''} as taught in Nigerian universities (MOUAU first, then the NUC CCMAS course content, then other Nigerian universities' course outlines).

Then plan comprehensive lecture notes for it. Reply with ONE JSON object in a \`\`\`json block, nothing else:
{
  "courseCode": "e.g. MTH 211 (keep the code given; empty string if none)",
  "courseTitle": "the official course title",
  "level": "e.g. 200",
  "units": "credit units if known, else empty string",
  "description": "4-6 sentence course description in plain English",
  "objectives": ["6-8 learning outcomes starting with a verb"],
  "schemeOfWork": [
    { "week": 1, "topic": "Topic title", "subtopics": ["3-6 subtopics"] }
  ],
  "references": ["5-8 standard textbooks: Author (Year). Title. Publisher."]
}
The scheme of work must have 12 to 14 weeks covering the whole syllabus in teaching order, with no revision or exam weeks.`
  const { text, model } = await ask({ system: TEACHER, prompt, search: true, maxTokens: 6000 })
  const plan = parseJsonBlock(text)
  const weeks = (Array.isArray(plan.schemeOfWork) ? plan.schemeOfWork : [])
    .filter((w) => w && w.topic)
    .slice(0, 15)
    .map((w, i) => ({ week: i + 1, topic: cleanText(w.topic), subtopics: (w.subtopics || []).map(cleanText).filter(Boolean).slice(0, 8) }))
  if (weeks.length < 6) throw new Error('The course plan came back too short')
  return {
    courseCode: (plan.courseCode || courseCode || '').toString().toUpperCase().replace(/\s+/g, ' ').trim(),
    courseTitle: cleanText(plan.courseTitle || title || courseCode),
    level: cleanText(plan.level || level || ''),
    units: cleanText(plan.units || ''),
    description: cleanText(plan.description || ''),
    objectives: (plan.objectives || []).map(cleanText).filter(Boolean).slice(0, 10),
    schemeOfWork: weeks,
    references: (plan.references || []).map(cleanText).filter(Boolean).slice(0, 10),
    model,
  }
}

async function writeChapter(plan, week) {
  const outline = plan.schemeOfWork.map((w) => `Week ${w.week}: ${w.topic}`).join('\n')
  const prompt = `Course: ${plan.courseCode} ${plan.courseTitle}${plan.level ? ` (${plan.level} level)` : ''}
Full scheme of work (for context, so you don't repeat other weeks):
${outline}

Write the complete lecture notes for WEEK ${week.week}: ${week.topic}
Subtopics to cover: ${week.subtopics.join('; ') || 'as appropriate'}

Structure:
### Learning outcomes
(4-6 bullet points: "By the end of this week you should be able to…")
### Introduction
(why this topic matters, linking to what came before)
Then one ### section per subtopic, each with clear explanations, definitions in **bold**, diagrams described in words or tables, and at least one worked example solved step by step where the subject allows.
### Key points to remember
(8-12 short bullet points)
### Practice questions
(5-8 questions, mixing short-answer and problem-solving)
### Answers to practice questions
(short, clear model answers or solution steps)

Aim for about 2,000-3,000 words. Do not include the week title as a heading; it is added for you.`
  const { text } = await ask({ system: TEACHER, prompt, search: false, maxTokens: 12000 })
  return cleanText(text)
}

async function writeRevision(plan) {
  const outline = plan.schemeOfWork.map((w) => `Week ${w.week}: ${w.topic} (${w.subtopics.join(', ')})`).join('\n')
  const prompt = `Course: ${plan.courseCode} ${plan.courseTitle}
Topics covered:
${outline}

Write the final revision chapter for these lecture notes:
### Course summary
(one short paragraph per week)
### Glossary
(25-40 key terms from the whole course, each as "- **Term**: plain-English definition", alphabetical)
### Exam-style revision questions
(15-20 questions in the style of a Nigerian university exam, grouped as Section A short answer and Section B essay/problem questions)
### Model answers and marking hints
(concise answers or solution outlines for every question)
### Study tips for this course
(5-8 practical tips)`
  const { text } = await ask({ system: TEACHER, prompt, search: false, maxTokens: 12000 })
  return cleanText(text)
}

// onProgress(percent, stepText) is called as each stage finishes.
export async function generateCourseNotes({ courseCode, title, level, department }, onProgress = () => {}) {
  const provider = notesProvider()
  onProgress(3, `Researching the course (${provider?.name || 'no AI'})`)
  const plan = await planCourse({ courseCode, title, level, department })
  onProgress(10, `Planned ${plan.schemeOfWork.length} weeks`)

  const chapters = []
  const total = plan.schemeOfWork.length + 1
  for (const week of plan.schemeOfWork) {
    onProgress(10 + Math.round((chapters.length / total) * 80), `Writing week ${week.week}: ${week.topic}`)
    chapters.push({ ...week, markdown: await writeChapter(plan, week) })
    if (provider?.name === 'gemini') await sleep(4000) // stay inside free-tier per-minute limits
  }
  onProgress(88, 'Writing the revision chapter')
  const revision = await writeRevision(plan)
  onProgress(92, 'Laying out the PDF')
  return { ...plan, chapters, revision, provider: provider?.name, model: workingGemini.default || plan.model }
}

// rcf-library-backend/src/utils/collectionDetector.js
// Pure deterministic detection — filename parsing + DB lookups only, no AI.
// Runs on every /analyze call regardless of whether Gemini is configured,
// so collection/chapter/edition detection never depends on the AI being up.
import { query } from '../db/pool.js'
import { normalizeCourseCode } from './courseCode.js'

const CHAPTER_RE = /chap(?:ter)?[\s_-]*0*(\d{1,3})/i
const PART_RE = /part[\s_-]*0*(\d{1,3})/i
const VOLUME_RE = /vol(?:ume)?[\s_-]*0*(\d{1,3})/i
const EDITION_RE = /(\d{1,2})(?:st|nd|rd|th)?[\s_-]*ed(?:ition)?\b|ed(?:ition)?[\s_-]*0*(\d{1,2})/i

// Same "LETTERS DIGITS" shape as normalizeCourseCode's own match regex —
// scans the filename for any substring that looks like a course code
// before handing it to normalizeCourseCode for the canonical form.
const COURSE_CODE_SCAN_RE = /\b[A-Za-z]{2,6}[\s-]?\d{2,4}\b/

function stripExtension(filename) {
  return String(filename || '').replace(/\.[^./\\]+$/, '')
}

function titleCaseWords(str) {
  return str
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toLowerCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

// Extracts chapter/part/volume/edition/course-code signals from a raw
// filename, then returns what's left as a cleaned title guess with all
// matched tokens removed — never guesses at content, only at what the
// filename's own text spells out.
export function parseFilenameSignals(originalFilename) {
  const noExt = stripExtension(originalFilename)
  const spaced = noExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()

  const chapterMatch = spaced.match(CHAPTER_RE)
  const partMatch = spaced.match(PART_RE)
  const volumeMatch = spaced.match(VOLUME_RE)
  const editionMatch = spaced.match(EDITION_RE)
  const courseScan = spaced.match(COURSE_CODE_SCAN_RE)
  const courseCode = courseScan ? normalizeCourseCode(courseScan[0]) : null

  let titleGuess = spaced
  for (const m of [chapterMatch, partMatch, volumeMatch, editionMatch, courseScan]) {
    if (m) titleGuess = titleGuess.replace(m[0], '')
  }
  titleGuess = titleGuess.replace(/\s+/g, ' ').trim()
  titleGuess = titleCaseWords(titleGuess) || null

  return {
    titleGuess,
    chapter: chapterMatch ? `Chapter ${chapterMatch[1]}` : null,
    part: partMatch ? `Part ${partMatch[1]}` : null,
    volume: volumeMatch ? `Volume ${volumeMatch[1]}` : null,
    edition: editionMatch ? `${editionMatch[1] || editionMatch[2]} Edition` : null,
    courseCode,
  }
}

// Fuzzy-matches titleGuess against existing resource_collections using
// the same pg_trgm similarity() function routes/resources.js already
// relies on for search — no new extension needed, already enabled.
// Returns the best candidate plus a confidence band the frontend uses to
// decide between silent pre-fill vs the "Possible collection detected"
// confirm prompt, per the spec's confidence thresholds.
async function matchCollection(titleGuess) {
  if (!titleGuess) return null

  const result = await query(
    `SELECT id, title, author, similarity(title, $1) AS score
     FROM resource_collections
     ORDER BY score DESC
     LIMIT 1`,
    [titleGuess]
  )

  const top = result.rows[0]
  if (!top || Number(top.score) < 0.3) return null

  return {
    collectionId: top.id,
    title: top.title,
    author: top.author,
    score: Number(top.score),
    confidence: Number(top.score) >= 0.6 ? 'high' : 'low',
  }
}

// resourceTypeSlug -> default section name when no chapter/edition signal
// narrows it further. Matches the spec's BOOK/AUDIO/OTHER EDITIONS example.
function guessSectionName({ resourceTypeSlug, edition }) {
  if (edition) return 'Other Editions'
  if (resourceTypeSlug === 'audio') return 'Audio'
  if (resourceTypeSlug === 'video') return 'Video'
  if (resourceTypeSlug === 'book') return 'Book'
  return null
}

// Single entry point called from routes/uploads.js POST /analyze.
// Writes nothing — pure read/suggest, same contract as analyzeResourceFile.
export async function detectCollectionAndSection({ originalFilename, resourceTypeSlug }) {
  const signals = parseFilenameSignals(originalFilename)
  const collectionMatch = await matchCollection(signals.titleGuess)

  return {
    ...signals,
    sectionGuess: guessSectionName({ resourceTypeSlug, edition: signals.edition }),
    collectionMatch, // null | { collectionId, title, author, score, confidence }
  }
}
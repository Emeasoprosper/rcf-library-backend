// rcf-library-backend/src/utils/courseCode.js
// Normalizes messy course-code input ("csc415", "CSC-415", "csc 415") into
// a single canonical form ("CSC 415") so lookups against the courses
// table are consistent regardless of how a user or the AI wrote it.
export function normalizeCourseCode(raw) {
  if (!raw) return null
  const cleaned = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  const match = cleaned.match(/^([A-Z]{2,6})\s?(\d{2,4})$/)
  if (!match) return cleaned
  return `${match[1]} ${match[2]}`
}
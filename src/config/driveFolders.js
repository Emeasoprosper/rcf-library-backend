// config/driveFolders.js
//
// Routes uploads into the specific Drive folders you already created,
// instead of dumping everything into one folder. Folder IDs come from
// .env (see .env.example) — they're not secrets, just configuration,
// so it's fine that they're plain strings rather than encrypted.

export const DRIVE_FOLDERS = {
  audio: process.env.GOOGLE_DRIVE_FOLDER_AUDIO,
  video: process.env.GOOGLE_DRIVE_FOLDER_VIDEOS,
  lecture_notes: process.env.GOOGLE_DRIVE_FOLDER_LECTURE_NOTES,
  past_question: process.env.GOOGLE_DRIVE_FOLDER_PAST_QUESTIONS,
  img: process.env.GOOGLE_DRIVE_FOLDER_IMG,
  // Catch-all for books, research papers, devotionals, collections, "other" —
  // anything that isn't one of the specific categories above.
  default: process.env.GOOGLE_DRIVE_FOLDER_OTHER_BOOKS,
}

// Decides which folder a given upload belongs in. Based on actual file
// mimetype first (audio/video/image are unambiguous), then resource type
// for document-style uploads where the folders are organized by subject
// rather than raw file type (a lecture note and a past question might both
// be PDFs, but they belong in different folders).
export function resolveUploadCategory({ mimetype, resourceTypeSlug }) {
  if (mimetype?.startsWith('image/')) return 'img'
  if (mimetype?.startsWith('audio/')) return 'audio'
  if (mimetype?.startsWith('video/')) return 'video'
  if (resourceTypeSlug === 'lecture_notes') return 'lecture_notes'
  if (resourceTypeSlug === 'past_question') return 'past_question'
  return 'default'
}

export function resolveFolderId(category) {
  const folderId = DRIVE_FOLDERS[category] || DRIVE_FOLDERS.default
  if (!folderId) {
    console.warn(`No Drive folder configured for category "${category}" — uploading to service account root instead.`)
  }
  return folderId || null
}

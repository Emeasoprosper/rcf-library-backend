// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/announcementMusic.js
import { Router } from 'express'
import multer from 'multer'
import { query } from '../db/pool.js'
import { attachUser, requireAuth, requireRole } from '../middleware/auth.js'
import { uploadToStorage, deleteFromStorage } from '../services/storage.js'

const router = Router()
router.use(attachUser, requireAuth, requireRole('admin', 'superadmin'))

const MAX_MUSIC_BYTES = 8 * 1024 * 1024
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,100}$/
const AUDIO_MIME_MAP = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/mp4': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/aac': 'audio/aac',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/ogg': 'audio/ogg',
  'audio/webm': 'audio/webm',
}

const musicUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MUSIC_BYTES },
  fileFilter: (req, file, cb) => {
    if (!AUDIO_MIME_MAP[file.mimetype]) return cb(new Error('Only audio files are supported (MP3, M4A, WAV or OGG).'))
    cb(null, true)
  },
})

// POST /admin/announcement-music/upload — stores the track privately in
// Drive. It only becomes playable once it is attached to an announcement.
router.post(
  '/upload',
  (req, res, next) => {
    musicUpload.single('file')(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'That track is too large. Music can be up to 8 MB.' })
      if (err) return next(err)
      next()
    })
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' })
    const stored = await uploadToStorage(req.file, 'audio', { makePublic: false })
    res.status(201).json({ fileId: stored.fileId, mime: AUDIO_MIME_MAP[req.file.mimetype] })
  }
)

// PATCH /admin/announcement-music/:id { fileId, mime, loop }
router.patch('/:id', async (req, res) => {
  const { fileId, mime, loop } = req.body || {}
  if (!FILE_ID_RE.test(String(fileId || ''))) return res.status(400).json({ error: 'Invalid music file' })
  const cleanMime = AUDIO_MIME_MAP[mime]
  if (!cleanMime) return res.status(400).json({ error: 'Invalid audio type' })

  const result = await query(
    `UPDATE announcements SET music_file_id = $1, music_mime = $2, music_loop = $3 WHERE id = $4 RETURNING id`,
    [fileId, cleanMime, loop !== false, req.params.id]
  )
  if (result.rows.length === 0) {
    await deleteFromStorage(fileId).catch(() => {})
    return res.status(404).json({ error: 'Announcement not found' })
  }
  res.json({ ok: true })
})

// GET /admin/announcement-music — which announcements have music.
router.get('/', async (req, res) => {
  const result = await query(`SELECT id, music_loop FROM announcements WHERE music_file_id IS NOT NULL`)
  res.json({ items: result.rows })
})

export default router
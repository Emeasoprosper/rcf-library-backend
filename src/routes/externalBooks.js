import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { attachUser, requireAuth } from '../middleware/auth.js'
import { searchArchiveBooks } from '../services/archiveSearch.js'
import { startImport, startTextbookImport, getJob } from '../services/externalImport.js'
import { searchAudiobooks, getAudiobookTracks } from '../services/librivoxSearch.js'
import { searchOpenTextbooks } from '../services/openTextbooks.js'

const router = Router()

// Strict, because every search makes outside requests from our server.
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
})

const importLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
})

// GET /api/external/search?q=organic chemistry
router.get('/search', searchLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (q.length < 3) return res.status(400).json({ error: 'Type at least 3 characters to search' })

  try {
    const items = await searchArchiveBooks(q)
    res.json({ query: q, count: items.length, items })
  } catch (err) {
    console.error('External book search failed:', err.message, err.cause?.code || '')
    res.status(502).json({ error: 'The external book search is unavailable right now' })
  }
})

// POST /api/external/import  { identifier }  -> { jobId } or { alreadyInLibrary, resourceId }
router.post('/import', attachUser, requireAuth, importLimiter, async (req, res) => {
  try {
    const result = await startImport(String(req.body?.identifier || ''), req.user.id)
    res.status(result.jobId ? 202 : 200).json(result)
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Could not add this book' })
  }
})

// POST /api/external/textbooks/import  { id }  -> { jobId } or { alreadyInLibrary, resourceId }
router.post('/textbooks/import', attachUser, requireAuth, importLimiter, async (req, res) => {
  try {
    const result = await startTextbookImport(String(req.body?.id || ''), req.user.id)
    res.status(result.jobId ? 202 : 200).json(result)
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Could not add this textbook' })
  }
})

// GET /api/external/import/:jobId -> { state: 'working' | 'done' | 'failed', resourceId, error }
router.get('/import/:jobId', attachUser, requireAuth, (req, res) => {
  const job = getJob(req.params.jobId, req.user.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.json(job)
})

// GET /api/external/audiobooks/search?q=pilgrim
// Read-only: lists public-domain audiobooks. Imports nothing yet.
router.get('/audiobooks/search', searchLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (q.length < 3) return res.status(400).json({ error: 'Type at least 3 characters to search' })

  try {
    const items = await searchAudiobooks(q)
    res.json({ query: q, count: items.length, items })
  } catch (err) {
    console.error('Audiobook search failed:', err.message, err.cause?.code || '')
    res.status(502).json({ error: 'The audiobook search is unavailable right now' })
  }
})

// GET /api/external/audiobooks/:identifier/tracks — chapters to play in the app.
router.get('/audiobooks/:identifier/tracks', searchLimiter, async (req, res) => {
  try {
    res.json(await getAudiobookTracks(req.params.identifier))
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    console.error('Audiobook tracks failed:', err.message, err.cause?.code || '')
    res.status(502).json({ error: 'Could not load this audiobook right now' })
  }
})

// GET /api/external/textbooks?q=biology — recent open textbooks, newest first.
router.get('/textbooks', searchLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim()
  if (q.length < 3) return res.status(400).json({ error: 'Type at least 3 characters to search' })
  try {
    const items = await searchOpenTextbooks(q)
    res.json({ query: q, count: items.length, items })
  } catch (err) {
    console.error('Open textbook search failed:', err.message, err.cause?.code || '')
    res.status(502).json({ error: 'The free textbook search is unavailable right now' })
  }
})

export default router
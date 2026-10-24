import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { attachUser, requireAuth } from '../middleware/auth.js'
import { searchArchiveBooks } from '../services/archiveSearch.js'
import { startImport, getJob } from '../services/externalImport.js'

const router = Router()

// Strict, because every search makes outside requests from our server.
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
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

// GET /api/external/import/:jobId -> { state: 'working' | 'done' | 'failed', resourceId, error }
router.get('/import/:jobId', attachUser, requireAuth, (req, res) => {
  const job = getJob(req.params.jobId, req.user.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.json(job)
})

export default router
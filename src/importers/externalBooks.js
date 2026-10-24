import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { searchArchiveBooks } from '../services/archiveSearch.js'

const router = Router()

// Strict, because every search makes outside requests from our server.
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
})

// GET /api/external/search?q=organic chemistry
// Read-only: lists books we could fetch. Imports nothing yet.
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

export default router
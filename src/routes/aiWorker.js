// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/aiWorker.js
// Private API for your own AI running in a Kaggle notebook (see
// tools/kaggle-notes-worker.py). Every call needs the header
//   x-worker-key: <AI_WORKER_KEY from Render's environment>
//
//   POST /api/ai-worker/heartbeat           { model }            -> { ok }
//   POST /api/ai-worker/claim               { model }            -> { job: null } | { job: { jobId, title, task } }
//   POST /api/ai-worker/jobs/:id/answer     { kind, week?, text, model } -> { next } | { done, resourceId, title }
//   POST /api/ai-worker/jobs/:id/release    { error }            -> { ok }
//
// task = { kind: 'plan' | 'chapter' | 'revision', week?, system, prompt, maxTokens }
import { Router } from 'express'
import crypto from 'node:crypto'
import { workerAnswer, workerClaim, workerHeartbeat, workerRelease } from '../services/aiLibrary.js'

const router = Router()

router.use((req, res, next) => {
  const expected = process.env.AI_WORKER_KEY || ''
  const given = String(req.get('x-worker-key') || '')
  const ok =
    expected.length >= 20 &&
    given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  if (!ok) return res.status(401).json({ error: 'Bad or missing worker key' })
  next()
})

const UUID = /^[0-9a-f-]{36}$/i

router.post('/heartbeat', async (req, res) => {
  await workerHeartbeat(req.body?.model)
  res.json({ ok: true })
})

router.post('/claim', async (req, res) => {
  res.json({ job: await workerClaim(req.body?.model) })
})

router.post('/jobs/:id/answer', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad job id' })
  try {
    const { kind, week, text, model } = req.body || {}
    res.json(await workerAnswer(req.params.id, { kind, week, text: String(text || '').slice(0, 200000), model }))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/jobs/:id/release', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad job id' })
  await workerRelease(req.params.id, req.body?.error)
  res.json({ ok: true })
})

export default router

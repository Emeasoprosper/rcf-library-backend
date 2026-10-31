// RCFMOUAULIBRARYreact/rcf-library-backend/src/server.js
import 'dotenv/config'

// MUST be imported before any route file — this patches Express so that
// errors thrown inside `async (req, res) => {...}` handlers are actually
// caught and forwarded to the error-handling middleware below, instead of
// becoming an unhandled promise rejection. Without this, Express 4 (what
// we're using) silently swallows async errors: the request just hangs
// forever with no response, and under repeated failures this is what was
// very likely causing the "sometimes it just crashes" behavior — every
// route in this project uses async handlers.
import 'express-async-errors'

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'

import authRoutes from './routes/auth.js'
import resourcesRoutes from './routes/resources.js'
import uploadsRoutes from './routes/uploads.js'
import adminRoutes from './routes/admin.js'
import adminAnalyticsRoutes from './routes/adminAnalytics.js'
import communityRoutes from './routes/community.js'
import analyticsRoutes from './routes/analytics.js'
import newsRoutes from './routes/news.js'
import resourceCollectionsRoutes from './routes/resourceCollections.js'
import presenceRoutes from './routes/presence.js'
import birthdaysRoutes from './routes/birthdays.js'
import announcementMusicRoutes from './routes/announcementMusic.js'
import readingSpaceRoutes from './routes/readingSpace.js'
import studyToolsRoutes from './routes/studyTools.js'
import { startBirthdayEmailLoop } from './services/birthdayEmails.js'
import shareLandingRoutes from './routes/shareLanding.js'
import shareTokenRoutes from './routes/shareToken.js'
import sitemapRoutes from './routes/sitemap.js'
import externalBooksRoutes from './routes/externalBooks.js'
import collectionLandingRoutes from './routes/collectionLanding.js'
import botRoutes from './routes/bot.js'
import engagementRoutes from './routes/engagement.js'
import { startNewsRefreshLoop } from './services/newsService.js'
import { recordEvent } from './services/systemEvents.js'

// Safety net for anything that still somehow escapes express-async-errors
// (e.g. an error thrown inside a setTimeout, or truly unexpected cases).
// Logging instead of letting Node's default behavior (crash the process)
// keeps the server serving other requests instead of taking the whole
// app down for everyone over one bad request.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})

const app = express()

// Two proxies sit in front of us: the site's own /backend rewrite on Vercel
// (so session cookies are first-party), then Render's load balancer. Trusting
// both makes req.ip the student's real address, so the rate limits below are
// per student instead of one shared bucket for everyone coming via Vercel.
app.set('trust proxy', 2)

// Same list CORS uses below — the admin PDF/video/image preview modal
// embeds this API's /admin/uploads/:id/preview-stream response in an
// <iframe>, so the frontend's own origin(s) need to be explicitly
// allowed to frame it. Helmet's default frameguard (X-Frame-Options:
// SAMEORIGIN) and its default CSP (frame-ancestors 'self') both treat
// "self" as this API's own origin — never the frontend's, since they're
// different origins/ports — so without this every embed gets silently
// blocked by the BROWSER (not the server) with a CSP console error,
// which is exactly the "gray broken file" bug this fixes.
// Add your production frontend domain(s) to FRONTEND_URLS in .env
// (comma-separated) before deploying — nothing else needs to change.
const allowedOrigins = (process.env.FRONTEND_URLS || '').split(',').map((s) => s.trim()).filter(Boolean)
// Vercel also serves the site at the project alias and at one unique URL per
// deployment (rcfmouaulib-<hash>-emeasoprospers-projects.vercel.app). Only
// this team's deployments can have that suffix, so it's safe to allow.
// Without this, anyone opening one of those links got "Not allowed by CORS".
const OWN_VERCEL_ORIGIN = /^https:\/\/rcfmouaulib(-[a-z0-9]+)?-emeasoprospers-projects\.vercel\.app$/
// Local development only (NODE_ENV=development in .env): the Vite dev server
// listens on 0.0.0.0, so the site is also opened from a phone on the same
// Wi-Fi (http://192.168.x.x:5173), on another port when 5173 is busy, or via
// `vite preview` (4173). Allow this computer and private LAN addresses on any
// port. Never active on Render.
const LOCAL_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}):\d{2,5}$/
const isLocalDev = process.env.NODE_ENV === 'development'
const isAllowedOrigin = (origin) =>
  allowedOrigins.includes(origin) || OWN_VERCEL_ORIGIN.test(origin) || (isLocalDev && LOCAL_DEV_ORIGIN.test(origin))
const frameAncestors = ["'self'", ...allowedOrigins, 'https://rcfmouaulib-emeasoprospers-projects.vercel.app']

app.use(
  helmet({
    // Thumbnails are served from this API and loaded cross-origin by the
    // frontend (localhost:5173 in dev, a different subdomain/domain in
    // most production setups). Helmet's default Cross-Origin-Resource-
    // Policy: same-origin causes the BROWSER to block rendering these
    // images even though the request itself returns 200 OK — confirmed
    // via net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin in DevTools.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // Allows the Google Sign-In popup flow to complete its handshake
    // back to this page via window.postMessage — Helmet's default
    // Cross-Origin-Opener-Policy (same-origin) blocks that handshake.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    // frameguard sets X-Frame-Options, which only ever supports ONE
    // value (DENY/SAMEORIGIN) and can't list multiple allowed origins —
    // disabled in favor of the CSP frame-ancestors directive below,
    // which can. Browsers that understand CSP ignore X-Frame-Options
    // anyway when both are present; browsers that don't understand CSP
    // are rare enough in 2026 that this tradeoff is fine.
    frameguard: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        frameAncestors,
      },
    },
  })
)
app.use(cookieParser())
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// The site reaches this API through Vercel's /backend rewrite, and Vercel can
// cache rewritten responses. Signed-in answers must never be cached and
// served to someone else, so opt every API response out.
app.use('/api', (req, res, next) => {
  res.set('x-vercel-enable-rewrite-caching', '0')
  next()
})

app.use((req, res, next) => {
  // Google's redirect-mode OAuth POSTs here as a real top-level form
  // submission from accounts.google.com, not a JS fetch — browsers never
  // enforce CORS on that kind of request (it's not a fetch/XHR at all),
  // so this route must bypass our origin allowlist entirely instead of
  // being rejected the way a cross-origin fetch would be. Without this
  // bypass, the shared cors() check below rejects the request with an
  // error (since accounts.google.com is never in FRONTEND_URLS), which
  // our error handler turns into a 400 — exactly the bug this fixes.
  if (req.path === '/api/auth/google/redirect-callback') return next()
  // Public SEO/share-unfurl pages — opened by link previews, search
  // engine crawlers, and normal top-level navigation, never a
  // same-origin fetch, so there's no Origin header to check and nothing
  // here needs cookies.
  if (req.path.startsWith('/s/') || req.path.startsWith('/library/') || req.path === '/sitemap.xml' || req.path === '/robots.txt') return next()

  cors({
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) return callback(null, true)
      // The origin is in the message so the admin Checkup page shows WHO was blocked.
      callback(new Error(`Not allowed by CORS (origin: ${String(origin).slice(0, 100)})`))
    },
    credentials: true,
  })(req, res, next)
})

app.use(
  '/api/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    // /api/bot is the WhatsApp bot's heartbeat, already locked by BOT_API_KEY.
    skip: (req) => req.originalUrl.startsWith('/api/presence') || req.originalUrl.startsWith('/api/bot'),
    standardHeaders: true,
    legacyHeaders: false,
  })
)

const strictLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 })
app.use('/api/auth/google', strictLimiter)
app.use('/api/auth/login', strictLimiter)
app.use('/api/auth/signup', strictLimiter)
app.use('/api/auth/handoff', strictLimiter)
app.use('/api/uploads', strictLimiter)

// Loose limiter on the public unfurl page — enough headroom for real
// crawler/link traffic, but a ceiling against someone scripting token
// guesses (tokens are 12 random url-safe chars, so guessing isn't
// realistically feasible anyway — this is just a backstop).
const shareLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120 })
app.use('/s/', shareLimiter)

app.get('/health', (req, res) => res.json({ ok: true }))
app.use('/', sitemapRoutes)
app.use('/s', shareTokenRoutes)
app.use('/library', shareLandingRoutes)
app.use('/collections', collectionLandingRoutes)

app.use('/api/auth', authRoutes)
app.use('/api/resources', resourcesRoutes)
app.use('/api/uploads', uploadsRoutes)
app.use('/api/admin/announcement-music', announcementMusicRoutes)
app.use('/api/admin/analytics', adminAnalyticsRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api', communityRoutes)
app.use('/api/analytics', analyticsRoutes)
app.use('/api/news', newsRoutes)
app.use('/api/resource-collections', resourceCollectionsRoutes)
app.use('/api/presence', presenceRoutes)
app.use('/api/birthdays', birthdaysRoutes)
app.use('/api/reading-space', readingSpaceRoutes)
app.use('/api/study', studyToolsRoutes)
app.use('/api/external', externalBooksRoutes)
app.use('/api/bot', botRoutes)
app.use('/api/engagement', engagementRoutes)

// Centralized error handler — now actually reachable for async route
// errors thanks to express-async-errors above. Every error, from anywhere
// in the app, ends up here as clean JSON instead of a crash or a hang.
// MUST stay last, after every route mount above — Express matches error
// handlers by position, so anything mounted after this point would never
// reach it.
app.use((err, req, res, next) => {
  console.error(err)
  {
    const urlPath = req.originalUrl.split('?')[0]
    recordEvent({
      kind: req.method === 'POST' && /^\/api\/uploads\/?$/.test(urlPath) ? 'upload_failed' : 'api_error',
      source: `${req.method} ${urlPath}`,
      message: err.message,
      status: err.status || 400,
      userId: req.user?.id,
    })
  }
  const status = err.status || 400
  res.status(status).json({ error: err.message || 'Something went wrong' })
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`)
  // Starts the 20-min external news refresh loop. Fetches once on boot,
  // then on a timer — never per-request, so this stays flat at 1M users.
  startNewsRefreshLoop()
  startBirthdayEmailLoop()
})
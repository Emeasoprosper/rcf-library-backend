import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET
const PREVIEW_TOKEN_TTL_SECONDS = 600 // 10 min — enough for Google's viewer to fetch office docs

// Attaches req.user if a valid access-token cookie is present.
// Does NOT block the request — use `requireAuth` for that.
export function attachUser(req, res, next) {
  const token = req.cookies?.rcflib_access_token
  if (!token) return next()

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.user = payload // { id, email, role, name }
  } catch {
    // expired/invalid token — treat as logged out, don't throw here
  }
  next()
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  next()
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' })
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }
    next()
  }
}

// Short-lived, resource-scoped token — lets the admin preview iframe (and
// Google's docs viewer, which fetches server-to-server with no cookies at
// all) hit preview-stream without relying on the session cookie surviving
// a cross-site iframe/fetch request.
export function signPreviewToken(resourceId, adminId) {
  return jwt.sign(
    { resourceId, adminId, scope: 'preview' },
    JWT_SECRET,
    { expiresIn: PREVIEW_TOKEN_TTL_SECONDS }
  )
}

export function verifyPreviewToken(token, resourceId) {
  const payload = jwt.verify(token, JWT_SECRET)
  if (payload.scope !== 'preview' || payload.resourceId !== resourceId) {
    throw new Error('Token does not match this resource')
  }
  return payload
}
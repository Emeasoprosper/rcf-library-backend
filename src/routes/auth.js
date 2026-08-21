// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/auth.js
import { Router } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import bcrypt from 'bcrypt'
import { query } from '../db/pool.js'
import { verifyGoogleIdToken, getDriveConsentUrl, exchangeCodeForDriveToken } from '../config/googleOAuth.js'
import { attachUser, requireAuth } from '../middleware/auth.js'
import { ADMIN_EMAILS } from '../config/admins.js'

const router = Router()

const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL_DAYS = 30
const BCRYPT_ROUNDS = 12

const cookieOpts = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  path: '/',
}

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  )
}

async function issueSession(res, user, req) {
  const refreshToken = crypto.randomBytes(48).toString('hex')
  const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)

  await query(
    `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, refreshTokenHash, req.headers['user-agent'] || null, req.ip, expiresAt]
  )

  res.cookie('rcflib_access_token', signAccessToken(user), {
    ...cookieOpts,
    maxAge: 15 * 60 * 1000,
  })
  res.cookie('rcflib_refresh_token', refreshToken, {
    ...cookieOpts,
    maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  })
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// POST /auth/check-email — lets the frontend silently decide whether to
// render the login form (password only) or signup form (with name) for
// a given email, without the user picking "sign in" vs "sign up"
// themselves. Deliberately reveals only enough to drive that UI
// decision — never whether the account has 2FA, its role, etc.
router.post('/check-email', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required.' })
  }

  const result = await query(
    'SELECT password_hash, google_id FROM users WHERE email = $1',
    [email]
  )

  if (result.rows.length === 0) {
    return res.json({ exists: false, hasPassword: false, googleOnly: false })
  }

  const { password_hash, google_id } = result.rows[0]
  res.json({
    exists: true,
    hasPassword: Boolean(password_hash),
    googleOnly: Boolean(google_id) && !password_hash,
  })
})

router.post('/signup', async (req, res) => {
  const { email, password, name } = req.body

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required.' })
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  }
  if (!name?.trim()) {
    return res.status(400).json({ error: 'Name is required.' })
  }

  const normalizedEmail = email.trim().toLowerCase()

  const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail])
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with this email already exists.' })
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const role = ADMIN_EMAILS.includes(normalizedEmail) ? 'admin' : 'student'

  const inserted = await query(
    `INSERT INTO users (email, password_hash, name, role, last_login_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING *`,
    [normalizedEmail, passwordHash, name.trim(), role]
  )
  const user = inserted.rows[0]

  await issueSession(res, user, req)
  res.json({ user: publicUser(user) })
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  const normalizedEmail = email.trim().toLowerCase()
  const result = await query('SELECT * FROM users WHERE email = $1', [normalizedEmail])

  if (result.rows.length === 0 || !result.rows[0].password_hash) {
    return res.status(401).json({ error: 'Invalid email or password.' })
  }

  const user = result.rows[0]
  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password.' })
  }

  if (user.is_suspended) {
    return res.status(403).json({ error: 'This account has been suspended.' })
  }

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
  await issueSession(res, user, req)
  res.json({ user: publicUser(user) })
})

router.post('/google', async (req, res) => {
  const { idToken } = req.body
  if (!idToken) return res.status(400).json({ error: 'idToken is required' })

  try {
    const profile = await verifyGoogleIdToken(idToken)

    const existing = await query('SELECT * FROM users WHERE google_id = $1', [profile.googleId])
    let user

    if (existing.rows.length > 0) {
      user = existing.rows[0]
      await query('UPDATE users SET last_login_at = now(), name = $1, avatar_url = $2 WHERE id = $3',
        [profile.name, profile.avatarUrl, user.id])
      user.name = profile.name
      user.avatar_url = profile.avatarUrl
    } else {
      const role = ADMIN_EMAILS.includes(profile.email.toLowerCase()) ? 'admin' : 'student'
      const inserted = await query(
        `INSERT INTO users (google_id, email, name, avatar_url, role, last_login_at)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
        [profile.googleId, profile.email, profile.name, profile.avatarUrl, role]
      )
      user = inserted.rows[0]
    }

    if (user.is_suspended) {
      return res.status(403).json({ error: 'This account has been suspended.' })
    }

    await issueSession(res, user, req)
    res.json({ user: publicUser(user) })
  } catch (err) {
    console.error('Google sign-in failed:', err.message)
    res.status(401).json({ error: 'Google sign-in failed' })
  }
})

router.get('/google/connect-drive', (req, res) => {
  res.redirect(getDriveConsentUrl())
})

router.get('/google/callback', async (req, res) => {
  try {
    const email = await exchangeCodeForDriveToken(req.query.code)
    res.send(`Drive connected successfully as ${email || '(unknown)'}. You can close this tab.`)
  } catch (err) {
    console.error('Drive connect failed:', err.message)
    res.status(500).send(`Drive connection failed: ${err.message}`)
  }
})

// POST /auth/google/redirect-callback — the ux_mode:'redirect' counterpart to
// POST /auth/google. Google submits the credential as a real HTML form POST
// here (not a JS fetch), so this can't return JSON — it sets the session
// cookies then 302-redirects the browser back to the frontend, already
// signed in. Avoids the whole "Failed to open popup window" failure mode
// entirely, since no popup is ever opened — the page just navigates.
// login_uri must match EXACTLY an Authorized redirect URI registered in
// Google Cloud Console — reading returnTo from a query string here
// broke that match (live "Error 400: redirect_uri_mismatch", blocking
// ALL Google sign-in). returnTo now round-trips via sessionStorage on
// the frontend instead — see SignIn.jsx and AppRoutes.jsx's RootRedirect.
router.post('/google/redirect-callback', async (req, res) => {
  const idToken = req.body?.credential
  const frontendUrl = (process.env.FRONTEND_URLS || '').split(',')[0]?.trim() || '/'

  if (!idToken) return res.redirect(`${frontendUrl}/signin?error=missing_credential`)

  try {
    const profile = await verifyGoogleIdToken(idToken)

    const existing = await query('SELECT * FROM users WHERE google_id = $1', [profile.googleId])
    let user

    if (existing.rows.length > 0) {
      user = existing.rows[0]
      await query('UPDATE users SET last_login_at = now(), name = $1, avatar_url = $2 WHERE id = $3',
        [profile.name, profile.avatarUrl, user.id])
      user.name = profile.name
      user.avatar_url = profile.avatarUrl
    } else {
      const role = ADMIN_EMAILS.includes(profile.email.toLowerCase()) ? 'admin' : 'student'
      const inserted = await query(
        `INSERT INTO users (google_id, email, name, avatar_url, role, last_login_at)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
        [profile.googleId, profile.email, profile.name, profile.avatarUrl, role]
      )
      user = inserted.rows[0]
    }

    if (user.is_suspended) {
      return res.redirect(`${frontendUrl}/signin?error=suspended`)
    }

    await issueSession(res, user, req)
    // Redirects to the app root, not directly to /home, so RootRedirect
    // in AppRoutes.jsx gets a chance to check sessionStorage for a
    // pending returnTo (set by SignIn.jsx) before deciding where to land.
    res.redirect(frontendUrl)
  } catch (err) {
    console.error('Google redirect sign-in failed:', err.message)
    res.redirect(`${frontendUrl}/signin?error=signin_failed`)
  }
})

router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.rcflib_refresh_token
  if (!refreshToken) return res.status(401).json({ error: 'No refresh token' })

  const hash = crypto.createHash('sha256').update(refreshToken).digest('hex')
  const result = await query(
    `SELECT s.*, u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = $1 AND s.expires_at > now()`,
    [hash]
  )

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid or expired session' })
  }

  const user = result.rows[0]
  res.cookie('rcflib_access_token', signAccessToken(user), {
    ...cookieOpts,
    maxAge: 15 * 60 * 1000,
  })
  res.json({ user: publicUser(user) })
})

router.post('/logout', attachUser, async (req, res) => {
  const refreshToken = req.cookies?.rcflib_refresh_token
  if (refreshToken) {
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex')
    await query('DELETE FROM sessions WHERE refresh_token_hash = $1', [hash])
  }
  res.clearCookie('rcflib_access_token', cookieOpts)
  res.clearCookie('rcflib_refresh_token', cookieOpts)
  res.json({ ok: true })
})

router.get('/me', attachUser, requireAuth, async (req, res) => {
  const result = await query('SELECT * FROM users WHERE id = $1', [req.user.id])
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })
  res.json({ user: publicUser(result.rows[0]) })
})

router.patch('/me', attachUser, requireAuth, async (req, res) => {
  const { name, bio } = req.body

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Name is required.' })
  }
  if (name.trim().length > 100) {
    return res.status(400).json({ error: 'Name is too long.' })
  }
  if (bio && bio.length > 500) {
    return res.status(400).json({ error: 'Bio must be 500 characters or fewer.' })
  }

  const result = await query(
    `UPDATE users SET name = $1, bio = $2, updated_at = now() WHERE id = $3 RETURNING *`,
    [name.trim(), bio?.trim() || null, req.user.id]
  )

  res.json({ user: publicUser(result.rows[0]) })
})

router.patch('/profile', attachUser, requireAuth, async (req, res) => {
  const { affiliation, category, institutionName, omitInstitution, department, level, studentId } = req.body

  if (!['mouau', 'other'].includes(affiliation)) {
    return res.status(400).json({ error: 'affiliation must be "mouau" or "other".' })
  }
  if (!['student', 'staff', 'alumnus', 'other'].includes(category)) {
    return res.status(400).json({ error: 'category must be student, staff, alumnus, or other.' })
  }

  let finalInstitution = null
  let finalDepartment = null
  let finalLevel = null
  let finalStudentId = null

  if (affiliation === 'other') {
    if (!omitInstitution && !institutionName?.trim()) {
      return res.status(400).json({ error: 'institutionName is required unless omitInstitution is set.' })
    }
    finalInstitution = omitInstitution ? null : institutionName.trim()
  }

  if (affiliation === 'mouau') {
    if (category === 'student') {
      if (!department?.trim() || !level?.trim() || !studentId?.trim()) {
        return res.status(400).json({ error: 'department, level, and studentId are required for MOUAU students.' })
      }
      finalDepartment = department.trim()
      finalLevel = level.trim()
      finalStudentId = studentId.trim()
    } else if (category === 'staff') {
      if (!department?.trim()) {
        return res.status(400).json({ error: 'department is required for MOUAU staff.' })
      }
      finalDepartment = department.trim()
    }
  }

  const result = await query(
    `UPDATE users
     SET affiliation = $1, category = $2, institution_name = $3,
         department = $4, level = $5, student_id = $6
     WHERE id = $7 RETURNING *`,
    [affiliation, category, finalInstitution, finalDepartment, finalLevel, finalStudentId, req.user.id]
  )

  res.json({ user: publicUser(result.rows[0]) })
})

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    role: user.role,
    bio: user.bio,
    affiliation: user.affiliation,
    category: user.category,
    institutionName: user.institution_name,
    department: user.department,
    level: user.level,
    studentId: user.student_id,
    profileComplete: Boolean(
      user.affiliation &&
      user.category &&
      (user.affiliation !== 'mouau' || user.category !== 'student' ||
        (user.department && user.level && user.student_id)) &&
      (user.affiliation !== 'mouau' || user.category !== 'staff' || user.department)
    ),
  }
}

export default router
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

const VALID_LEVELS = new Set(['100', '200', '300', '400', '500', 'PG'])
const VALID_GENDERS = new Set(['Male', 'Female'])

router.patch('/me', attachUser, requireAuth, async (req, res) => {
  const { name, bio, department, level, gender } = req.body

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Name is required.' })
  }
  if (name.trim().length > 100) {
    return res.status(400).json({ error: 'Name is too long.' })
  }
  if (bio && bio.length > 500) {
    return res.status(400).json({ error: 'Bio must be 500 characters or fewer.' })
  }
  if (department !== undefined && department !== null && String(department).trim().length > 100) {
    return res.status(400).json({ error: 'Department is too long.' })
  }
  if (level !== undefined && level !== null && level !== '' && !VALID_LEVELS.has(level)) {
    return res.status(400).json({ error: 'Invalid level.' })
  }
  if (gender !== undefined && gender !== null && gender !== '' && !VALID_GENDERS.has(gender)) {
    return res.status(400).json({ error: 'Invalid gender.' })
  }

  const result = await query(
    `UPDATE users SET
       name = $1, bio = $2,
       department = COALESCE(NULLIF($3, ''), department),
       level = COALESCE(NULLIF($4, ''), level),
       gender = COALESCE(NULLIF($5, ''), gender),
       updated_at = now()
     WHERE id = $6 RETURNING *`,
    [name.trim(), bio?.trim() || null, department?.trim() || '', level || '', gender || '', req.user.id]
  )

  res.json({ user: publicUser(result.rows[0]) })
})

router.patch('/profile', attachUser, requireAuth, async (req, res) => {
  const { affiliation, category, institutionName, omitInstitution, department, level, studentId, gender, isRcfMember, joinReason, heardFrom } = req.body

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
         department = $4, level = $5, student_id = $6,
         gender = $7, is_rcf_member = $8, join_reason = $9, heard_from = $10
     WHERE id = $11 RETURNING *`,
    [
      affiliation, category, finalInstitution, finalDepartment, finalLevel, finalStudentId,
      gender || null, typeof isRcfMember === 'boolean' ? isRcfMember : null, joinReason || null, heardFrom || null,
      req.user.id,
    ]
  )

  res.json({ user: publicUser(result.rows[0]) })
})

router.patch('/privacy', attachUser, requireAuth, async (req, res) => {
  const { showProfile, showHistory } = req.body
  if (typeof showProfile !== 'boolean' || typeof showHistory !== 'boolean') {
    return res.status(400).json({ error: 'showProfile and showHistory must both be booleans.' })
  }
  const result = await query(
    `UPDATE users SET show_profile = $1, show_history = $2, updated_at = now() WHERE id = $3 RETURNING *`,
    [showProfile, showHistory, req.user.id]
  )
  res.json({ user: publicUser(result.rows[0]) })
})

// PATCH /auth/profile-extra — fills in the newer optional details
// (gender, RCF membership, join reason, heard-from) for a user who
// already completed the core MOUAU profile earlier, before these
// fields existed. Deliberately has none of /profile's strict
// validation — this is a light top-up, one field at a time, never a
// re-run of the full registration form.
router.patch('/profile-extra', attachUser, requireAuth, async (req, res) => {
  const { gender, isRcfMember, joinReason, heardFrom } = req.body
  const result = await query(
    `UPDATE users SET
       gender = COALESCE($1, gender),
       is_rcf_member = COALESCE($2, is_rcf_member),
       join_reason = COALESCE($3, join_reason),
       heard_from = COALESCE($4, heard_from)
     WHERE id = $5 RETURNING *`,
    [gender || null, typeof isRcfMember === 'boolean' ? isRcfMember : null, joinReason || null, heardFrom || null, req.user.id]
  )
  res.json({ user: publicUser(result.rows[0]) })
})

// ---- Birthday and contact details ----
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function validMonthDay(month, day) {
  return (
    Number.isInteger(month) && Number.isInteger(day) &&
    month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]
  )
}

// Returns the number as +<country code><digits>, or null if it does not
// look like a real phone number. Nigerian numbers without a country code
// (08012345678) are accepted and converted to +234.
function normalizePhone(raw) {
  const trimmed = String(raw || '').trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null
  let international
  if (trimmed.startsWith('+')) international = digits
  else if (trimmed.startsWith('00')) international = digits.slice(2)
  else if (digits.startsWith('234') && digits.length === 13) international = digits
  else if (digits.startsWith('0') && digits.length === 11) international = `234${digits.slice(1)}`
  else if (digits.length === 10 && /^[789]/.test(digits)) international = `234${digits}`
  else return null
  if (international.length < 8 || international.length > 15) return null
  return `+${international}`
}

// PATCH /auth/birthday-contact — a field that is left out keeps its value;
// a field sent empty is cleared.
router.patch('/birthday-contact', attachUser, requireAuth, async (req, res) => {
  const found = await query('SELECT * FROM users WHERE id = $1', [req.user.id])
  const current = found.rows[0]
  if (!current) return res.status(404).json({ error: 'User not found' })

  const body = req.body || {}
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key)
  const blank = (v) => v === undefined || v === null || String(v).trim() === ''

  let birthMonth = current.birth_month
  let birthDay = current.birth_day
  if (has('birthMonth') || has('birthDay')) {
    if (blank(body.birthMonth) && blank(body.birthDay)) {
      birthMonth = null
      birthDay = null
    } else {
      const m = Number(body.birthMonth)
      const d = Number(body.birthDay)
      if (!validMonthDay(m, d)) return res.status(400).json({ error: 'Pick a real birthday: a month and a day that exist.' })
      birthMonth = m
      birthDay = d
    }
  }

  const phoneError = 'Enter the number with its country code, for example +2348012345678.'
  let phone = current.phone_number
  if (has('phoneNumber')) {
    if (blank(body.phoneNumber)) phone = null
    else {
      phone = normalizePhone(body.phoneNumber)
      if (!phone) return res.status(400).json({ error: phoneError })
    }
  }
  let whatsapp = current.whatsapp_number
  if (has('whatsappNumber')) {
    if (blank(body.whatsappNumber)) whatsapp = null
    else {
      whatsapp = normalizePhone(body.whatsappNumber)
      if (!whatsapp) return res.status(400).json({ error: phoneError })
    }
  }

  const birthdayPublic = typeof body.birthdayPublic === 'boolean' ? body.birthdayPublic : current.birthday_public
  let contactPublic = typeof body.contactPublic === 'boolean' ? body.contactPublic : current.contact_public
  if (!phone && !whatsapp) contactPublic = false // nothing to share

  const updated = await query(
    `UPDATE users SET
       birthday_emailed_year = CASE WHEN birth_month IS DISTINCT FROM $1 OR birth_day IS DISTINCT FROM $2
                                    THEN NULL ELSE birthday_emailed_year END,
       birth_month = $1, birth_day = $2, phone_number = $3, whatsapp_number = $4,
       birthday_public = $5, contact_public = $6, updated_at = now()
     WHERE id = $7 RETURNING *`,
    [birthMonth, birthDay, phone, whatsapp, birthdayPublic, contactPublic, req.user.id]
  )
  res.json({ user: publicUser(updated.rows[0]) })
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
    gender: user.gender,
    isRcfMember: user.is_rcf_member,
    joinReason: user.join_reason,
    heardFrom: user.heard_from,
    birthMonth: user.birth_month,
    birthDay: user.birth_day,
    phoneNumber: user.phone_number,
    whatsappNumber: user.whatsapp_number,
    birthdayPublic: user.birthday_public,
    contactPublic: user.contact_public,
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
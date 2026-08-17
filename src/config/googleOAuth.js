import { OAuth2Client } from 'google-auth-library'
import { query } from '../db/pool.js'

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

export async function verifyGoogleIdToken(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  })
  const payload = ticket.getPayload()

  if (!payload.email_verified) {
    throw new Error('Google email not verified')
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name,
    avatarUrl: payload.picture,
  }
}

function buildDriveOAuthClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

export function getDriveConsentUrl() {
  return buildDriveOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
  })
}

export async function exchangeCodeForDriveToken(code) {
  const oauth2Client = buildDriveOAuthClient()
  const { tokens } = await oauth2Client.getToken(code)

  if (!tokens.refresh_token) {
    throw new Error('No refresh_token returned — revoke access at https://myaccount.google.com/permissions and try connecting again.')
  }

  let email = null
  if (tokens.id_token) {
    try {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID })
      email = ticket.getPayload()?.email || null
    } catch {
      // non-fatal
    }
  }

  await query(
    `INSERT INTO google_drive_auth (id, refresh_token, connected_email, connected_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET refresh_token = $1, connected_email = $2, connected_at = now()`,
    [tokens.refresh_token, email]
  )

  return email
}

export async function getDelegatedDriveClient() {
  const result = await query('SELECT refresh_token FROM google_drive_auth WHERE id = 1')
  if (result.rows.length === 0) {
    throw new Error('Drive is not connected yet. Visit /api/auth/google/connect-drive to authorize uploads.')
  }

  const oauth2Client = buildDriveOAuthClient()
  oauth2Client.setCredentials({ refresh_token: result.rows[0].refresh_token })
  return oauth2Client
}
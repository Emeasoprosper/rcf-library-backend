// Comma-separated in .env
// Anyone signing in with one of these emails is auto-promoted to 'admin'
// on account creation. Promote/demote anyone else via the Admin > Users screen.
export const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

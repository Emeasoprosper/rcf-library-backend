import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
}

// Supabase/Neon require SSL; disable only for local Postgres during dev.
const useSSL = process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL,
  max: 10, // free-tier DBs cap connections low — keep this conservative
})

export async function query(text, params) {
  const start = Date.now()
  const res = await pool.query(text, params)
  if (process.env.NODE_ENV !== 'production') {
    console.log('[db]', text.split('\n')[0].trim(), `${Date.now() - start}ms`, `rows=${res.rowCount}`)
  }
  return res
}

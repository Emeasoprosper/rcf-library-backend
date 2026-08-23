// rcf-library-backend/src/services/authorLookup.js
import { query } from '../db/pool.js'

// Wikipedia's summary endpoint — not raw Wikidata SPARQL. Single clean
// call, no API key, and thumbnail.source is the same image Wikipedia
// itself displays (Commons-licensed), so there's no scraped-image
// rights ambiguity the way a raw Google Images result would carry.
const WIKIPEDIA_SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary/'

async function fetchWikipediaImage(name) {
  try {
    const res = await fetch(`${WIKIPEDIA_SUMMARY_URL}${encodeURIComponent(name)}`)
    if (!res.ok) return null
    const data = await res.json()
    // 'disambiguation' pages (e.g. a common name matching multiple
    // people) have no reliable single photo — treated as not found
    // rather than guessing which person it means.
    if (data.type === 'disambiguation') return null
    return {
      imageUrl: data.thumbnail?.source || null,
      bio: data.extract ? data.extract.slice(0, 500) : null,
    }
  } catch (err) {
    console.warn(`[authorLookup] Wikipedia lookup failed for "${name}":`, err.message)
    return null
  }
}

// Finds an existing author by name (case-insensitive, same dedupe style
// as categories/tags) or creates one, looking up a photo/bio exactly
// once per unique name — never re-queried on subsequent uploads by the
// same author. Never blocks or fails an upload: any lookup failure just
// leaves image_url null, same as "no author photo available."
export async function findOrCreateAuthor(rawName) {
  const trimmed = (rawName || '').trim()
  if (!trimmed) return null

  const existing = await query('SELECT id, name, image_url FROM authors WHERE name ILIKE $1', [trimmed])
  if (existing.rows.length > 0) return existing.rows[0].id

  const lookup = await fetchWikipediaImage(trimmed)

  const inserted = await query(
    `INSERT INTO authors (name, image_url, image_source, bio)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [trimmed, lookup?.imageUrl || null, lookup?.imageUrl ? 'wikipedia' : null, lookup?.bio || null]
  )

  if (inserted.rows.length > 0) return inserted.rows[0].id

  // Concurrent request won the insert race — re-read rather than error.
  const reread = await query('SELECT id FROM authors WHERE name ILIKE $1', [trimmed])
  return reread.rows[0]?.id || null
}
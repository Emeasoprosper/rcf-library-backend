// Searches LibriVox (public-domain audiobooks). Read-only; imports nothing.
// LibriVox only supports "title starts with" and "author last name" searches.
const UA = { 'User-Agent': 'RCF-MOUAU-Library/1.0 (+https://rcf-mouau-library.vercel.app)' }
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 100
const MIN_YEARS_SINCE_DEATH = 70
const cache = new Map()

async function fetchBooks(paramString) {
  const url = `https://librivox.org/api/feed/audiobooks?format=json&limit=12&${paramString}`
  let lastErr
  for (let i = 1; i <= 2; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body) {
        // LibriVox answers "not found" with an error body, which just means no matches.
        if (body?.error || res.status === 404) return []
        throw new Error(`LibriVox returned ${res.status}`)
      }
      return Array.isArray(body.books) ? body.books : []
    } catch (err) {
      lastErr = err
      if (i < 2) await new Promise((r) => setTimeout(r, 1500))
    }
  }
  throw lastErr
}

// Every credited author must have died at least 70 years ago (covers Nigerian and US rules).
function authorsOk(authors) {
  if (!Array.isArray(authors) || authors.length === 0) return false
  const latestAllowed = new Date().getFullYear() - MIN_YEARS_SINCE_DEATH
  return authors.every((a) => {
    const dod = Number(a.dod)
    return dod > 0 && dod <= latestAllowed
  })
}

function toItem(b) {
  if (!/^english$/i.test(String(b.language || ''))) return null
  if (!authorsOk(b.authors)) return null
  const secs = Number(b.totaltimesecs) || 0
  const chapters = Number(b.num_sections) || 0
  if (secs <= 0 || chapters <= 0 || chapters > 400) return null
  const identifier = /\/compress\/([^/]+)\//.exec(b.url_zip_file || '')?.[1]
  if (!identifier) return null
  return {
    librivoxId: String(b.id),
    identifier,
    title: String(b.title || '').slice(0, 250),
    author: b.authors.map((a) => `${a.first_name || ''} ${a.last_name || ''}`.trim()).join(', '),
    authorDied: Math.max(...b.authors.map((a) => Number(a.dod))),
    chapters,
    totalTime: b.totaltime || null,
    approxMB: Math.round(secs * 0.00763 * 10) / 10, // 64 kbps
    sourceUrl: b.url_librivox || null,
    coverUrl: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
  }
}

export async function searchAudiobooks(rawQuery) {
  const q = String(rawQuery || '').trim().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (q.length < 3) return []

  const key = q.toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items

  const lastWord = q.split(' ').filter((w) => w.length >= 3).pop()
  const searches = [fetchBooks(`title=^${encodeURIComponent(q)}`)]
  if (lastWord) searches.push(fetchBooks(`author=${encodeURIComponent(lastWord)}`))

  const settled = await Promise.allSettled(searches)
  if (settled.every((s) => s.status === 'rejected')) throw settled[0].reason

  const seen = new Set()
  const items = []
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue
    for (const b of s.value) {
      const item = toItem(b)
      if (item && !seen.has(item.librivoxId)) {
        seen.add(item.librivoxId)
        items.push(item)
      }
    }
  }

  const result = items.slice(0, 8)
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), items: result })
  return result
}
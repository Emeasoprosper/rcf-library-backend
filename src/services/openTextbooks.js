// Searches the Open Textbook Library (University of Minnesota): peer-reviewed,
// openly licensed university textbooks, most of them recent. Read-only: we
// link to the publisher's own free copy, nothing is downloaded or re-hosted.
//
// Why this and not "newest Creative Commons" on archive.org: anyone can put a
// CC label on an upload there, and the newest/most-downloaded "CC" items are
// mostly pirated commercial books. The publishers here licence their own work.
const UA = { 'User-Agent': 'RCF-MOUAU-Library/1.0 (+https://rcf-mouau-library.vercel.app)', Accept: 'application/json' }
const API = 'https://open.umn.edu/opentextbooks/textbooks.json'
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 100
const cache = new Map()

function pickFormat(formats, types) {
  for (const type of types) {
    const f = (formats || []).find((x) => String(x.type || '').toLowerCase() === type && /^https?:\/\//.test(x.url || ''))
    if (f) return f.url
  }
  return null
}

function toItem(t) {
  const pageUrl = t.url || `https://open.umn.edu/opentextbooks/textbooks/${t.id}`
  const authors = (t.contributors || [])
    .filter((c) => c.primary !== false)
    .map((c) => [c.first_name, c.last_name].filter(Boolean).join(' ').trim())
    .filter(Boolean)
  return {
    kind: 'textbook',
    id: String(t.id),
    title: String(t.title || '').slice(0, 250),
    author: authors.slice(0, 3).join(', ') || null,
    year: Number(t.copyright_year) || null,
    licence: t.license ? `Creative Commons ${t.license}` : 'Open licence',
    description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 220),
    subjects: (t.subjects || []).slice(0, 2).map((s) => s.name),
    rating: t.rating ? Number(t.rating) : null,
    readUrl: pickFormat(t.formats, ['online', 'ebook']) || pageUrl,
    pdfUrl: pickFormat(t.formats, ['pdf']),
    sourceUrl: pageUrl,
  }
}

export async function searchOpenTextbooks(rawQuery) {
  const q = String(rawQuery || '').trim().slice(0, 80)
  if (q.length < 3) return []
  const key = q.toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items

  const res = await fetch(`${API}?q=${encodeURIComponent(q)}`, { headers: UA, signal: AbortSignal.timeout(25000) })
  if (!res.ok) throw new Error(`Open Textbook Library returned ${res.status}`)
  const body = await res.json()
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []

  // Newest first, so the latest editions lead.
  const items = list
    .filter((t) => t && t.title && (t.language || 'eng').startsWith('eng'))
    .map(toItem)
    .sort((a, b) => (b.year || 0) - (a.year || 0))
    .slice(0, 8)

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), items })
  return items
}

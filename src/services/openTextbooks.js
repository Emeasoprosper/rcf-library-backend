// Searches the Open Textbook Library (University of Minnesota): peer-reviewed,
// openly licensed university textbooks, most of them recent. Only books we
// can bring into the app's own reader are listed: a real PDF file, within
// the import size limit, under a licence that allows sharing a copy
// (NoDerivatives is excluded because our downloads are watermarked).
//
// Why this and not "newest Creative Commons" on archive.org: anyone can put a
// CC label on an upload there, and the newest/most-downloaded "CC" items are
// mostly pirated commercial books. The publishers here licence their own work.
const UA = { 'User-Agent': 'RCF-MOUAU-Library/1.0 (+https://rcf-mouau-library.vercel.app)', Accept: 'application/json' }
const API = 'https://open.umn.edu/opentextbooks/textbooks.json'
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 100
const MAX_PDF_BYTES = 60 * 1024 * 1024 // same cap as externalImport.js
const cache = new Map()

const licenceAllowsCopy = (licence) => Boolean(licence) && !/noderiv/i.test(licence)

// Is this link an actual PDF we can import? Many "PDF" links in the
// catalogue are web pages. HEAD first; some hosts refuse HEAD, so fall back
// to fetching just the first byte.
async function probePdf(url) {
  if (!url) return null
  const attempt = async (init) => {
    const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) }, redirect: 'follow', signal: AbortSignal.timeout(9000) })
    res.body?.cancel?.().catch(() => {})
    const type = String(res.headers.get('content-type') || '').toLowerCase()
    const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')
    const size = Number(range?.[1] || res.headers.get('content-length') || 0)
    return { ok: res.ok, type, size, finalUrl: res.url || url }
  }
  try {
    let r = await attempt({ method: 'HEAD' })
    if (!r.ok || !r.type) r = await attempt({ method: 'GET', headers: { Range: 'bytes=0-0' } })
    if (!r.ok || !r.type.includes('application/pdf')) return null
    if (r.size && r.size > MAX_PDF_BYTES) return null
    return { url: r.finalUrl, size: r.size || null }
  } catch {
    return null
  }
}

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

// Re-checks one textbook at import time. Never trusts anything the browser sent.
export async function getImportableTextbook(id) {
  if (!/^\d{1,8}$/.test(String(id || ''))) throw Object.assign(new Error('Invalid textbook id'), { status: 400 })
  const res = await fetch(`https://open.umn.edu/opentextbooks/textbooks/${id}.json`, { headers: UA, signal: AbortSignal.timeout(25000) })
  if (!res.ok) throw Object.assign(new Error('Textbook not found'), { status: 404 })
  const body = await res.json()
  const t = body?.data || body
  if (!t?.title) throw Object.assign(new Error('Textbook not found'), { status: 404 })
  if (!licenceAllowsCopy(t.license)) throw Object.assign(new Error('This textbook\'s licence does not allow adding a copy'), { status: 400 })
  const item = toItem(t)
  const pdf = await probePdf(item.pdfUrl)
  if (!pdf) throw Object.assign(new Error('This textbook has no PDF we can add'), { status: 400 })
  return {
    identifier: String(t.id),
    title: item.title,
    author: item.author,
    year: item.year ? String(item.year) : null,
    licence: item.licence,
    sourceUrl: item.sourceUrl,
    downloadUrl: pdf.url,
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

  // Newest first, so the latest editions lead. Then keep only the ones that
  // can open in the app (checked in parallel).
  const candidates = list
    .filter((t) => t && t.title && (t.language || 'eng').startsWith('eng') && licenceAllowsCopy(t.license))
    .map(toItem)
    .filter((t) => t.pdfUrl)
    .sort((a, b) => (b.year || 0) - (a.year || 0))
    .slice(0, 10)
  const probes = await Promise.all(candidates.map((t) => probePdf(t.pdfUrl)))
  const items = candidates
    .map((t, i) => (probes[i] ? { ...t, sizeMB: probes[i].size ? Math.round((probes[i].size / 1048576) * 10) / 10 : null } : null))
    .filter(Boolean)
    .map(({ readUrl, pdfUrl, ...rest }) => rest) // never send outside links to the app
    .slice(0, 8)

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), items })
  return items
}

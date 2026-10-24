// Re-checks one item at import time. Never trusts anything the browser sent.
export async function getImportableItem(identifier) {
  if (!/^[A-Za-z0-9._-]{3,200}$/.test(String(identifier || ''))) throw new Error('Invalid item id')
  const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`)
  const m = meta.metadata || {}
  const title = Array.isArray(m.title) ? m.title[0] : m.title
  if (!title || BLOCKED_TITLE.test(title)) throw new Error('This item cannot be imported')
  const year = String(m.year || m.date || '').slice(0, 4)
  const verdict = licenceVerdict(m, year)
  if (!verdict.ok) throw new Error(`Not importable: ${verdict.label}`)
  const pdf = pickPdf(meta.files)
  if (!pdf) throw new Error('No suitable PDF file on this item')
  const creator = Array.isArray(m.creator) ? m.creator.join(', ') : m.creator
  return {
    identifier,
    title: String(title).slice(0, 250),
    author: creator ? String(creator).slice(0, 250) : null,
    year: year || null,
    licence: verdict.label,
    sourceUrl: `https://archive.org/details/${identifier}`,
    pdfName: pdf.name,
    pdfBytes: Number(pdf.size),
  }
}

// Searches the Internet Archive for books we are allowed to offer: open access,
// positive licence evidence, a real PDF within our size limits. Read-only.
const UA = { 'User-Agent': 'RCF-MOUAU-Library/1.0 (+https://rcf-mouau-library.vercel.app)' }
const MAX_BYTES = 60 * 1024 * 1024
const MIN_BYTES = 200 * 1024
const BLOCKED_TITLE = /explosive|munition|weapon|bomb|poison|narcotic|hacking/i
const STOP_WORDS = new Set(['the', 'and', 'of', 'to', 'for', 'in', 'on', 'an', 'is', 'are', 'by'])
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 100
const cache = new Map()

async function fetchJson(url, tries = 2) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { ...UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error(`archive.org returned ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      if (i < tries) await new Promise((r) => setTimeout(r, 1500))
    }
  }
  throw lastErr
}

// Only items with positive licence evidence may ever be offered.
export function licenceVerdict(meta, year) {
  const lic = String(meta.licenseurl || '').toLowerCase()
  if (lic.includes('creativecommons.org/publicdomain/zero') || lic.includes('publicdomain/mark')) {
    return { ok: true, label: 'Public domain / CC0' }
  }
  if (lic.includes('creativecommons.org/licenses/')) {
    // NoDerivatives licences forbid changes, and our downloads are watermarked.
    if (lic.includes('-nd')) return { ok: false, label: 'NoDerivatives licence' }
    return { ok: true, label: `Creative Commons (${meta.licenseurl})` }
  }
  if (String(meta['possible-copyright-status'] || '').toUpperCase() === 'NOT_IN_COPYRIGHT') {
    const y = Number(year)
    if (y && y <= 1900) return { ok: true, label: `Public domain (published ${y})` }
    return { ok: false, label: 'Marked public domain but published after 1900' }
  }
  return { ok: false, label: 'No licence evidence' }
}

export function pickPdf(files) {
  const pdfs = (files || []).filter(
    (f) => /\.pdf$/i.test(f.name || '') && Number(f.size) >= MIN_BYTES && Number(f.size) <= MAX_BYTES
  )
  if (pdfs.length === 0) return null
  return pdfs.find((f) => /text pdf/i.test(f.format || '')) || pdfs[0]
}

function buildQuery(q) {
  const words = String(q || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .slice(0, 6)
  if (words.length === 0) return null
  return `(${words.join(' AND ')}) AND mediatype:texts AND -access-restricted-item:true AND (licenseurl:* OR possible-copyright-status:NOT_IN_COPYRIGHT)`
}

async function findDocs(q) {
  const params = new URLSearchParams({ q, rows: '20', page: '1', output: 'json' })
  for (const f of ['identifier', 'title', 'creator', 'year']) params.append('fl[]', f)
  const data = await fetchJson(`https://archive.org/advancedsearch.php?${params}`)
  return data.response?.docs || []
}

async function evaluate(doc) {
  if (BLOCKED_TITLE.test(doc.title || '')) return null
  const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`)
  const verdict = licenceVerdict(meta.metadata || {}, doc.year)
  if (!verdict.ok) return null
  const pdf = pickPdf(meta.files)
  if (!pdf) return null
  return {
    identifier: doc.identifier,
    title: doc.title,
    author: Array.isArray(doc.creator) ? doc.creator.join(', ') : doc.creator || null,
    year: doc.year || null,
    sizeMB: Math.round((Number(pdf.size) / 1048576) * 10) / 10,
    licence: verdict.label,
    sourceUrl: `https://archive.org/details/${doc.identifier}`,
  }
}

export async function searchArchiveBooks(rawQuery) {
  const key = String(rawQuery || '').trim().toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items

  const q = buildQuery(rawQuery)
  if (!q) return []

  const docs = await findDocs(q)
  const items = []
  for (let i = 0; i < docs.length && items.length < 8; i += 5) {
    const settled = await Promise.allSettled(docs.slice(i, i + 5).map(evaluate))
    for (const s of settled) if (s.status === 'fulfilled' && s.value) items.push(s.value)
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), items: items.slice(0, 8) })
  return items.slice(0, 8)
}
// Tests the Internet Archive as an on-demand book source. Writes nothing anywhere.
// Run from rcf-library-backend:
//   node --dns-result-order=ipv4first --no-network-family-autoselection src/importers/probe-archive.js "your search words"
const TERM = process.argv.slice(2).join(' ') || 'pilgrim progress bunyan'
const UA = { 'User-Agent': 'RCF-MOUAU-Library-probe/1.0' }
const MAX_MB = 60
const why = (e) => `${e.message} | cause: ${e.cause?.code || e.cause?.message || e.cause || 'none'}`

async function fetchRetry(url, options = {}, tries = 3) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(30000) })
    } catch (err) {
      lastErr = err
      if (i < tries) await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw lastErr
}

async function getJson(url) {
  const res = await fetchRetry(url, { headers: { ...UA, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function search(q) {
  const params = new URLSearchParams({ q, rows: '10', page: '1', output: 'json' })
  for (const f of ['identifier', 'title', 'creator', 'year', 'licenseurl', 'downloads']) params.append('fl[]', f)
  // no sort[] on purpose: default order is relevance
  const data = await getJson(`https://archive.org/advancedsearch.php?${params}`)
  return data.response || { numFound: 0, docs: [] }
}

async function rangeTest(url) {
  try {
    const res = await fetchRetry(url, { headers: { ...UA, Range: 'bytes=0-99' }, redirect: 'follow' })
    const out = { status: res.status, type: res.headers.get('content-type'), contentRange: res.headers.get('content-range') }
    if (res.body) await res.body.cancel()
    return out
  } catch (err) {
    return { status: 'error', error: why(err) }
  }
}

// Only items with positive licence evidence may ever be imported.
function licenceVerdict(m, year) {
  const lic = String(m.licenseurl || '').toLowerCase()
  if (lic.includes('creativecommons.org/publicdomain/zero') || lic.includes('publicdomain/mark')) return { ok: true, why: 'public domain / CC0' }
  if (lic.includes('creativecommons.org/licenses/')) {
    if (lic.includes('-nd')) return { ok: false, why: 'BLOCKED: NoDerivatives licence (our downloads are watermarked)' }
    return { ok: true, why: `Creative Commons (${m.licenseurl})` }
  }
  if (String(m['possible-copyright-status'] || '').toUpperCase() === 'NOT_IN_COPYRIGHT') {
    const y = Number(year)
    if (y && y <= 1900) return { ok: true, why: `marked NOT_IN_COPYRIGHT, published ${y}` }
    return { ok: false, why: 'CHECK: marked public domain but published after 1900 (or year unknown)' }
  }
  return { ok: false, why: 'BLOCKED: no licence evidence' }
}

async function main() {
  console.log(`Searching archive.org for: ${TERM}\n`)
  const q = `(${TERM}) AND mediatype:texts AND -access-restricted-item:true AND (licenseurl:* OR possible-copyright-status:NOT_IN_COPYRIGHT)`
  const found = await search(q)
  console.log(`Matches (open + licence field present): ${found.numFound}`)

  for (const doc of (found.docs || []).slice(0, 6)) {
    try {
      console.log(`\n"${doc.title}" by ${doc.creator || 'unknown'} (${doc.year || '?'}) id=${doc.identifier}`)
      const meta = await getJson(`https://archive.org/metadata/${doc.identifier}`)
      const m = meta.metadata || {}
      const verdict = licenceVerdict(m, doc.year)
      console.log(`  licence: ${verdict.ok ? 'OK' : 'NO'} -> ${verdict.why}`)

      const pdfs = (meta.files || []).filter((f) => /\.pdf$/i.test(f.name || ''))
      if (pdfs.length === 0) {
        console.log('  no PDF file -> not usable with the current reader')
        continue
      }
      const pdf = pdfs[0]
      const mb = pdf.size ? Number(pdf.size) / 1048576 : null
      console.log(`  pdf: ${pdf.name} (${mb ? mb.toFixed(1) : '?'} MB)`)

      const r = await rangeTest(encodeURI(`https://archive.org/download/${doc.identifier}/${pdf.name}`))
      const works = r.status === 206 || r.status === 200
      console.log(`  download test: status=${r.status}${r.error ? ' error=' + r.error : ''}`)

      const small = mb !== null && mb <= MAX_MB
      if (verdict.ok && works && small) console.log('  RESULT: IMPORTABLE')
      else console.log(`  RESULT: not importable (licence ok=${verdict.ok}, download works=${works}, under ${MAX_MB} MB=${small})`)
    } catch (err) {
      console.log('  check failed for this item:', why(err))
    }
  }
}

main().catch((e) => console.log('Probe failed:', why(e)))
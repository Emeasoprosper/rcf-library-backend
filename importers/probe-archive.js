// Tests the Internet Archive as an on-demand book source. Writes nothing anywhere.
// Run from rcf-library-backend:  node src/importers/probe-archive.js "your search words"
const TERM = process.argv.slice(2).join(' ') || 'pilgrim progress bunyan'
const UA = { 'User-Agent': 'RCF-MOUAU-Library-probe/1.0' }
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
  const params = new URLSearchParams({ q, rows: '8', page: '1', output: 'json' })
  for (const f of ['identifier', 'title', 'creator', 'year', 'licenseurl', 'downloads']) params.append('fl[]', f)
  params.append('sort[]', 'downloads desc')
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

async function main() {
  console.log(`Searching archive.org for: ${TERM}\n`)
  const open = await search(`(${TERM}) AND mediatype:texts AND -access-restricted-item:true`)
  console.log(`Matches (open items only): ${open.numFound}`)

  for (const doc of (open.docs || []).slice(0, 5)) {
    try {
      console.log(`\n"${doc.title}" by ${doc.creator || 'unknown'} (${doc.year || '?'}) id=${doc.identifier} downloads=${doc.downloads}`)
      const meta = await getJson(`https://archive.org/metadata/${doc.identifier}`)
      const m = meta.metadata || {}
      console.log('  licenseurl:', m.licenseurl || 'none')
      console.log('  possible-copyright-status:', m['possible-copyright-status'] || 'none')
      console.log('  access-restricted-item:', m['access-restricted-item'] || 'not set')

      const pdfs = (meta.files || []).filter((f) => /\.pdf$/i.test(f.name || ''))
      if (pdfs.length === 0) {
        console.log('  no PDF file -> classification: Not usable with the current reader')
        continue
      }
      const pdf = pdfs[0]
      const mb = pdf.size ? (Number(pdf.size) / 1048576).toFixed(1) : '?'
      console.log(`  pdf: ${pdf.name} (${mb} MB, format=${pdf.format})`)

      const r = await rangeTest(encodeURI(`https://archive.org/download/${doc.identifier}/${pdf.name}`))
      console.log(`  download test: status=${r.status} type=${r.type} content-range=${r.contentRange}${r.error ? ' error=' + r.error : ''}`)

      const works = r.status === 206 || r.status === 200
      const hasLicenceEvidence = Boolean(m.licenseurl) || /public domain/i.test(m['possible-copyright-status'] || '')
      if (!works) console.log('  classification: Unavailable / unverified')
      else if (hasLicenceEvidence) console.log('  classification: Full content + download available (licence evidence present)')
      else console.log('  classification: Downloads work but LICENCE UNKNOWN -> do not import without a check')
    } catch (err) {
      console.log('  check failed for this item:', why(err))
    }
  }
}

main().catch((e) => console.log('Probe failed:', why(e)))
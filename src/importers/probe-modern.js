// Tests OAPEN and CORE as sources of recent open-access books and papers.
// Writes nothing anywhere. Run from rcf-library-backend:
//   node --dns-result-order=ipv4first --no-network-family-autoselection src/importers/probe-modern.js "soil"
const TERM = process.argv.slice(2).join(' ') || 'agriculture'
const UA = { 'User-Agent': 'RCF-MOUAU-Library-probe/1.0', Accept: 'application/json' }
const why = (e) => `${e.message} | cause: ${e.cause?.code || e.cause?.message || 'none'}`

async function getJson(url, headers = {}) {
  let lastErr
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      if (i < 3) await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw lastErr
}

async function rangeTest(url) {
  try {
    const res = await fetch(url, { headers: { ...UA, Range: 'bytes=0-99' }, redirect: 'follow', signal: AbortSignal.timeout(30000) })
    const out = `status=${res.status} type=${res.headers.get('content-type')} content-range=${res.headers.get('content-range')}`
    if (res.body) await res.body.cancel()
    return out
  } catch (err) {
    return `error: ${why(err)}`
  }
}

async function probeOapen() {
  console.log(`\n=== OAPEN: "${TERM}" ===`)
  const url = `https://library.oapen.org/rest/search?query=${encodeURIComponent(TERM)}&expand=metadata,bitstreams&limit=5`
  const data = await getJson(url)
  const list = Array.isArray(data) ? data : data.items || []
  console.log(`Items returned: ${list.length} (showing up to 5)`)
  if (list[0]) console.log('Item fields:', Object.keys(list[0]).join(', '))

  for (const it of list.slice(0, 5)) {
    try {
      const meta = it.metadata || []
      const val = (k) => meta.filter((m) => m.key === k).map((m) => m.value).join(', ')
      console.log(`\n"${it.name}"`)
      console.log('  issued:', val('dc.date.issued') || '?', '| handle:', it.handle)
      const rights = meta.filter((m) => /rights|licen/i.test(m.key)).map((m) => `${m.key}=${m.value}`)
      console.log('  licence fields:', rights.join(' | ') || 'none found')
      const pdfs = (it.bitstreams || []).filter((b) => /pdf/i.test(b.mimeType || b.name || ''))
      if (pdfs.length === 0) { console.log('  no PDF bitstream found'); continue }
      const b = pdfs[0]
      console.log('  bitstream fields:', Object.keys(b).join(', '))
      console.log(`  pdf: ${b.name} (${b.sizeBytes ? (b.sizeBytes / 1048576).toFixed(1) + ' MB' : '? MB'}) link: ${b.retrieveLink}`)
      const link = String(b.retrieveLink || '')
      const full = link.startsWith('http') ? link : `https://library.oapen.org/rest${link}`
      console.log('  download test:', await rangeTest(full))
    } catch (err) {
      console.log('  check failed:', why(err))
    }
  }
}

async function probeCore() {
  console.log(`\n=== CORE: "${TERM}" ===`)
  const key = process.env.CORE_API_KEY
  const q = encodeURIComponent(`(${TERM}) AND _exists_:downloadUrl`)
  const url = `https://api.core.ac.uk/v3/search/works?q=${q}&limit=5`
  const data = await getJson(url, key ? { Authorization: `Bearer ${key}` } : {})
  const list = data.results || []
  console.log(`Total matches: ${data.totalHits ?? '?'} | key used: ${key ? 'yes' : 'no'}`)
  if (list[0]) console.log('Result fields:', Object.keys(list[0]).join(', '))

  for (const w of list.slice(0, 5)) {
    try {
      console.log(`\n"${w.title}" (${w.yearPublished || '?'})`)
      console.log('  licence-like fields:', Object.keys(w).filter((k) => /licen|rights/i.test(k)).map((k) => `${k}=${JSON.stringify(w[k])}`).join(' | ') || 'none')
      console.log('  downloadUrl:', w.downloadUrl || 'none')
      if (w.downloadUrl) console.log('  download test:', await rangeTest(w.downloadUrl))
    } catch (err) {
      console.log('  check failed:', why(err))
    }
  }
}

try { await probeOapen() } catch (e) { console.log('OAPEN probe failed:', why(e)) }
try { await probeCore() } catch (e) { console.log('CORE probe failed:', why(e)) }
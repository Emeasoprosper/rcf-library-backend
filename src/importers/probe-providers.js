// Prints what LibriVox, archive.org and Gutendex really offer. Writes nothing anywhere.
// Run from rcf-library-backend:  node src/importers/probe-providers.js
const SITE_ORIGIN = 'https://rcf-mouau-library.vercel.app'
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

// Asks for just the first 100 bytes. A 206 answer means seeking works; a 200 means it does not.
async function rangeTest(url) {
  try {
    const res = await fetchRetry(url, { headers: { ...UA, Range: 'bytes=0-99', Origin: SITE_ORIGIN }, redirect: 'follow' })
    const out = {
      status: res.status,
      type: res.headers.get('content-type'),
      contentRange: res.headers.get('content-range'),
      cors: res.headers.get('access-control-allow-origin'),
    }
    if (res.body) await res.body.cancel()
    return out
  } catch (err) {
    return { status: 'error', error: why(err) }
  }
}

async function probeLibrivox() {
  console.log('\n=== LibriVox + archive.org ===')
  const data = await getJson('https://librivox.org/api/feed/audiobooks?format=json&limit=3')
  const books = data.books || []
  console.log(`Books returned: ${books.length}`)

  try {
    const ext = await getJson('https://librivox.org/api/feed/audiobooks?format=json&limit=1&extended=1')
    const first = ext.books?.[0]
    console.log('extended=1 -> sections present:', Array.isArray(first?.sections))
    if (first?.sections?.[0]) console.log('  section fields:', Object.keys(first.sections[0]).join(', '))
  } catch (err) {
    console.log('extended=1 check failed:', why(err))
  }

  for (const b of books) {
    try {
      console.log(`\n"${b.title}" language=${b.language} sections=${b.num_sections} totaltime=${b.totaltime}`)
      const identifier = /\/compress\/([^/]+)\//.exec(b.url_zip_file || '')?.[1]
      if (!identifier) {
        console.log('  no archive.org identifier found -> classification: Metadata only')
        continue
      }
      console.log('  archive.org identifier:', identifier)

      const meta = await getJson(`https://archive.org/metadata/${identifier}`)
      const files = meta.files || []
      console.log('  access-restricted-item:', meta.metadata?.['access-restricted-item'] || 'not set')
      console.log('  formats present:', [...new Set(files.map((f) => f.format))].join(' | '))

      const mp3s = files.filter((f) => /mp3/i.test(f.format || '') && /\.mp3$/i.test(f.name || '')).slice(0, 2)
      if (mp3s.length === 0) console.log('  no .mp3 files found -> classification: Unavailable / needs another check')

      for (const f of mp3s) {
        const url = encodeURI(`https://archive.org/download/${identifier}/${f.name}`)
        const r = await rangeTest(url)
        console.log(`  file: ${f.name} (${f.format}, ${f.size} bytes)`)
        console.log(`    status=${r.status} type=${r.type} content-range=${r.contentRange} CORS allow-origin=${r.cors}${r.error ? ' error=' + r.error : ''}`)
        const seekable = r.status === 206
        console.log(`    classification: ${seekable ? 'Full content + download available (seek works)' : r.status === 200 ? 'Full content, seeking NOT supported' : 'Unavailable / unverified'}`)
      }
    } catch (err) {
      console.log('  check failed for this book:', why(err))
    }
  }
}

async function probeGutendex() {
  console.log('\n=== Gutendex (metadata only, no file requests to gutenberg.org) ===')
  const data = await getJson('https://gutendex.com/books?languages=en&search=bunyan')
  const results = data.results || []
  console.log(`Books returned: ${results.length}`)
  for (const b of results.slice(0, 3)) {
    console.log(`\n"${b.title}" id=${b.id} copyright=${b.copyright}`)
    console.log('  formats offered:', Object.keys(b.formats || {}).join(' | '))
  }
}

try { await probeLibrivox() } catch (e) { console.log('LibriVox probe failed:', why(e)) }
try { await probeGutendex() } catch (e) { console.log('Gutendex probe failed:', why(e)) }
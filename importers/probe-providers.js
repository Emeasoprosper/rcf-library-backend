// Prints what LibriVox, archive.org and Gutendex really offer. Writes nothing anywhere.
// Run from rcf-library-backend:  node src/importers/probe-providers.js
const SITE_ORIGIN = 'https://rcf-mouau-library.vercel.app'
const UA = { 'User-Agent': 'RCF-MOUAU-Library-probe/1.0', Accept: 'application/json' }

async function getJson(url) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { ...UA, Origin: SITE_ORIGIN } })
    return {
      ok: res.ok,
      status: res.status,
      type: res.headers.get('content-type'),
      bytes: res.headers.get('content-length'),
      seekable: res.headers.get('accept-ranges'),
      cors: res.headers.get('access-control-allow-origin'),
    }
  } catch (err) {
    return { ok: false, status: 'error', error: err.message }
  }
}

async function probeLibrivox() {
  console.log('\n=== LibriVox + archive.org ===')
  const data = await getJson('https://librivox.org/api/feed/audiobooks?format=json&limit=3&extended=1')
  const books = data.books || []
  console.log(`Books returned: ${books.length}`)
  if (books[0]) console.log('Fields on a book:', Object.keys(books[0]).join(', '))

  for (const b of books) {
    try {
      console.log(`\n"${b.title}" language=${b.language} sections=${b.num_sections}`)
      console.log('  sections array present:', Array.isArray(b.sections), '| url_iarchive:', b.url_iarchive || 'none')
      if (Array.isArray(b.sections) && b.sections[0]) {
        console.log('  section fields:', Object.keys(b.sections[0]).join(', '))
      }

      const identifier = (b.url_iarchive || '').split('/').filter(Boolean).pop()
      if (!identifier) {
        console.log('  no archive.org identifier -> classification: Metadata only')
        continue
      }

      const meta = await getJson(`https://archive.org/metadata/${identifier}`)
      const files = meta.files || []
      console.log('  access-restricted-item:', meta.metadata?.['access-restricted-item'] || 'not set')
      console.log('  formats present:', [...new Set(files.map((f) => f.format))].join(' | '))

      const mp3s = files.filter((f) => /mp3/i.test(f.format || '')).slice(0, 2)
      if (mp3s.length === 0) console.log('  no MP3 files found -> classification: Unavailable / needs another check')

      for (const f of mp3s) {
        const url = encodeURI(`https://archive.org/download/${identifier}/${f.name}`)
        const r = await head(url)
        console.log(`  file: ${f.name} (${f.format})`)
        console.log(`    reachable=${r.ok} status=${r.status} type=${r.type} bytes=${r.bytes}`)
        console.log(`    seekable (accept-ranges)=${r.seekable} | CORS allow-origin=${r.cors}`)
        console.log(`    classification: ${r.ok ? 'Full content + download available' : 'Unavailable / unverified'}`)
      }
    } catch (err) {
      console.log('  check failed for this book:', err.message)
    }
  }
}

async function probeGutendex() {
  console.log('\n=== Gutendex (metadata only, no file requests to gutenberg.org) ===')
  const data = await getJson('https://gutendex.com/books?languages=en&search=bunyan%20pilgrim')
  for (const b of (data.results || []).slice(0, 3)) {
    console.log(`\n"${b.title}" id=${b.id} copyright=${b.copyright}`)
    console.log('  formats offered:', Object.keys(b.formats || {}).join(' | '))
  }
}

try { await probeLibrivox() } catch (e) { console.log('LibriVox probe failed:', e.message) }
try { await probeGutendex() } catch (e) { console.log('Gutendex probe failed:', e.message) }
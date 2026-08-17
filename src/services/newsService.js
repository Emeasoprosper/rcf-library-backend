// services/newsService.js
import { query } from '../db/pool.js'

const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY
const NEWSDATA_URL = 'https://newsdata.io/api/1/latest'

// Keyword list drives what counts as "relevant" academic news for a
// Nigerian student audience. Adjust freely — it's just an OR query.
const KEYWORDS = ['WAEC', 'JAMB', 'ASUU', 'MOUAU', 'NUC', 'university']

// Fetches fresh education news from NewsData.io and writes it into
// news_cache. This is the ONLY function that ever talks to the external
// API — call it from a timer, not from a request handler, so traffic
// volume never changes how often NewsData.io gets hit.
export async function refreshNewsCache() {
  if (!NEWSDATA_API_KEY) {
    console.warn('NEWSDATA_API_KEY not set — skipping news refresh.')
    return
  }

  const params = new URLSearchParams({
    apikey: NEWSDATA_API_KEY,
    country: 'ng',
    category: 'education',
    q: KEYWORDS.join(' OR '),
    language: 'en',
  })

  try {
    const res = await fetch(`${NEWSDATA_URL}?${params.toString()}`)
    if (!res.ok) throw new Error(`NewsData.io responded ${res.status}`)
    const data = await res.json()

    const items = (data.results || []).slice(0, 10).map((r) => ({
      title: r.title,
      link: r.link,
      description: r.description,
      imageUrl: r.image_url,
      sourceName: r.source_name,
      publishedAt: r.pubDate,
    }))

    await query(
      `INSERT INTO news_cache (source, payload) VALUES ('newsdata', $1)`,
      [JSON.stringify(items)]
    )

    // Keep the table small — only the last 5 fetches, so it never grows
    // unbounded over months of uptime.
    await query(`
      DELETE FROM news_cache
      WHERE id NOT IN (SELECT id FROM news_cache ORDER BY fetched_at DESC LIMIT 5)
    `)

    console.log(`News cache refreshed: ${items.length} items.`)
  } catch (err) {
    console.error('Failed to refresh news cache:', err.message)
    // Deliberately not throwing — a failed refresh just means the next
    // request serves slightly stale cached data instead of crashing.
  }
}

// Starts the periodic refresh. Call once from server.js on boot.
// 20 minutes keeps well inside NewsData.io's free daily credit limit
// (200/day ÷ 1 call per refresh = plenty of headroom) regardless of how
// many students are using the app at once.
export function startNewsRefreshLoop() {
  refreshNewsCache() // fetch once immediately on boot, don't wait 20 min
  setInterval(refreshNewsCache, 20 * 60 * 1000)
}

// Reads whatever is currently cached — this is what the /news route
// calls. No external request happens here, ever.
export async function getCachedExternalNews() {
  try {
    const result = await query(
      `SELECT payload, fetched_at FROM news_cache ORDER BY fetched_at DESC LIMIT 1`
    )
    if (result.rows.length === 0) return { items: [], fetchedAt: null }
    return { items: result.rows[0].payload, fetchedAt: result.rows[0].fetched_at }
  } catch (err) {
    // If the table doesn't exist yet (migration not run) or another DB
    // error occurs, return an empty result instead of throwing so the
    // server stays up and other routes continue to work.
    console.warn('Could not read news_cache:', err.message)
    return { items: [], fetchedAt: null }
  }
}
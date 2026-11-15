// Forgiving title search: finds "Principles of Accounting" when someone types
// "principle acounting", "princ of acct" or "ACC211" for "ACC 211".
// score(query, text) is 1 for an exact (contained) match, otherwise 0..1 for
// how close the words are.

const SHORT_FORMS = {
  intro: 'introduction', princ: 'principles', prin: 'principles', mgt: 'management', mgmt: 'management',
  acct: 'accounting', accts: 'accounting', econs: 'economics', biz: 'business', maths: 'mathematics',
  stats: 'statistics', mktg: 'marketing', comm: 'communication', govt: 'government', pq: 'past questions',
  pqs: 'past questions', '&': 'and',
}

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/([a-z]{3})\s?-?(\d{3})/g, '$1 $2') // "mth211" / "mth-211" -> "mth 211"
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SHORT_FORMS[w] || w)
    .join(' ')
}

const LITTLE = new Set(['of', 'the', 'and', 'to', 'in', 'a', 'an', 'for', 'on'])

function distance(a, b) {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1))
      last = keep
    }
  }
  return prev[b.length]
}

function wordScore(q, words) {
  let best = 0
  for (const w of words) {
    if (/^\d+$/.test(q) || /^\d+$/.test(w)) {
      if (q === w) return 1
      continue // numbers must match exactly (211 is not 212)
    }
    if (w === q) return 1
    if (q.length >= 3 && w.startsWith(q)) best = Math.max(best, 0.9) // "princ" -> "principles"
    const sim = 1 - distance(q, w) / Math.max(q.length, w.length)
    best = Math.max(best, sim)
  }
  return best
}

export function score(query, text) {
  const q = normalize(query)
  const t = normalize(text)
  if (!q || !t) return 0
  if (t.includes(q)) return 1
  const words = t.split(' ')
  const qWords = q.split(' ').filter((w) => !LITTLE.has(w))
  if (!qWords.length) return 0
  const scores = qWords.map((w) => wordScore(w, words))
  // A course number that doesn't match at all rules it out.
  if (qWords.some((w, i) => /^\d+$/.test(w) && scores[i] === 0)) return 0
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

export const SIMILAR_ENOUGH = 0.72

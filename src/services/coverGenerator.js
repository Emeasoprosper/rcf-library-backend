// services/coverGenerator.js
//
// Solves the DOCX/PPT preview problem honestly: instead of a real "page 1"
// render (which needs LibreOffice — not available on free hosting, see
// previewQueue.js notes), this generates a designed cover card from the
// resource's own metadata: title, author, and type. Similar in spirit to
// how Spotify generates default playlist art, or how a well-designed
// document management system shows a styled card instead of a broken icon.
//
// This is NOT a fake preview of the document's contents — it never claims
// to show page 1. It's a distinct, intentional design treatment, and it
// works for every file type as a fallback, not just DOCX/PPT.

import sharp from 'sharp'

const PALETTES = {
  book: ['#3730a3', '#6366f1'],
  past_question: ['#b45309', '#f59e0b'],
  research_paper: ['#0f766e', '#2dd4bf'],
  lecture_notes: ['#334155', '#64748b'],
  devotional: ['#9f1239', '#fb7185'],
  audio: ['#6d28d9', '#a78bfa'],
  video: ['#b91c1c', '#f87171'],
  collection: ['#0e7490', '#22d3ee'],
  other: ['#404040', '#737373'],
}

function paletteFor(slug) {
  return PALETTES[slug] || PALETTES.other
}

function escapeXml(str) {
  return String(str ?? '').replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ))
}

// Cheap word-wrap by estimated character count — good enough for a
// generated cover, doesn't need real font-metrics precision.
function wrapText(text, maxCharsPerLine, maxLines) {
  const words = String(text || 'Untitled').split(' ')
  const lines = []
  let current = ''
  for (const word of words) {
    const candidate = (current + ' ' + word).trim()
    if (candidate.length > maxCharsPerLine) {
      if (current) lines.push(current)
      current = word
    } else {
      current = candidate
    }
    if (lines.length === maxLines) break
  }
  if (current && lines.length < maxLines) lines.push(current)
  if (lines.length === maxLines && lines[maxLines - 1].length >= maxCharsPerLine) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, maxCharsPerLine - 1).trim() + '…'
  }
  return lines
}

// Returns a PNG buffer — caller is responsible for uploading it to storage.
export async function generateCoverCard({ title, author, typeSlug, typeLabel }) {
  const [c1, c2] = paletteFor(typeSlug)
  const lines = wrapText(title, 18, 4)
  const monogram = String(title || '?').trim().charAt(0).toUpperCase() || '?'
  const titleBlockTop = 560

  const svg = `
<svg width="600" height="800" viewBox="0 0 600 800" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}" />
      <stop offset="100%" stop-color="${c2}" />
    </linearGradient>
    <pattern id="stripes" width="40" height="40" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="40" stroke="white" stroke-opacity="0.06" stroke-width="12" />
    </pattern>
  </defs>

  <rect width="600" height="800" fill="url(#bg)" />
  <rect width="600" height="800" fill="url(#stripes)" />

  <circle cx="64" cy="64" r="28" fill="white" fill-opacity="0.15" stroke="white" stroke-opacity="0.4" stroke-width="1.5" />
  <text x="64" y="73" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="white" text-anchor="middle">${escapeXml(monogram)}</text>

  <rect x="${560 - (String(typeLabel || '').length * 8 + 40)}" y="40" width="${String(typeLabel || '').length * 8 + 40}" height="32" rx="16" fill="white" fill-opacity="0.15" />
  <text x="540" y="61" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="white" text-anchor="end" letter-spacing="1">${escapeXml((typeLabel || '').toUpperCase())}</text>

  <text x="48" y="${titleBlockTop}" font-family="Arial, sans-serif" font-size="40" font-weight="800" fill="white">
    ${lines.map((line, i) => `<tspan x="48" dy="${i === 0 ? 0 : 46}">${escapeXml(line)}</tspan>`).join('')}
  </text>

  ${author ? `<text x="48" y="${titleBlockTop + lines.length * 46 + 36}" font-family="Arial, sans-serif" font-size="18" fill="white" fill-opacity="0.85">${escapeXml(author)}</text>` : ''}

  <text x="48" y="756" font-family="Arial, sans-serif" font-size="12" fill="white" fill-opacity="0.55" letter-spacing="1">RCF MOUAU LIBRARY</text>
</svg>`.trim()

  return sharp(Buffer.from(svg)).png().toBuffer()
}

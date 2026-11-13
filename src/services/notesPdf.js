// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/notesPdf.js
// Turns generated notes (noteGenerator.js) into a branded A4 PDF:
//   cover (RCF logo, course, "Author: RCF MOUAU") -> course overview with the
//   scheme of work -> one chapter per week -> revision chapter.
// Every page after the cover has a small-logo header and page numbers.
// Renders the Markdown subset the generator is told to use: ### / ####
// headings, bullets, numbered lists, pipe tables, **bold**, *italic*,
// `code`, > callouts, ``` blocks and --- rules.
import PDFDocument from 'pdfkit'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets')
const LOGO = path.join(ASSETS, 'rcf-logo.png')
const FONT = (name) => path.join(ASSETS, 'fonts', `LiberationSans-${name}.ttf`)

const INK = '#1f2433'
const MUTED = '#5f6577'
const ACCENT = '#c2410c' // RCF orange
const NAVY = '#16235e'
const RULE = '#d9dbe3'
const TINT = '#f4f5f9'

const PAGE = { size: 'A4', margins: { top: 78, bottom: 70, left: 62, right: 62 } }
const BODY = 10.8
const LINE_GAP = 2.6

function setup() {
  const doc = new PDFDocument({ ...PAGE, bufferPages: true, autoFirstPage: false, info: {} })
  doc.registerFont('Body', FONT('Regular'))
  doc.registerFont('Bold', FONT('Bold'))
  doc.registerFont('Italic', FONT('Italic'))
  doc.registerFont('BoldItalic', FONT('BoldItalic'))
  return doc
}

const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right
const bottomLimit = (doc) => doc.page.height - doc.page.margins.bottom

function ensureSpace(doc, needed) {
  if (doc.y + needed > bottomLimit(doc)) doc.addPage()
}

// Inline **bold**, *italic*, `code` in one flowing paragraph.
function richText(doc, text, { size = BODY, color = INK, x, width, indent = 0, align = 'left' } = {}) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g).filter((p) => p !== '')
  const left = x ?? doc.page.margins.left
  const w = width ?? contentWidth(doc)
  doc.fillColor(color).fontSize(size)
  if (!parts.length) return
  parts.forEach((part, i) => {
    let font = 'Body'
    let piece = part
    if (/^\*\*[^*]+\*\*$/.test(part)) { font = 'Bold'; piece = part.slice(2, -2) }
    else if (/^\*[^*]+\*$/.test(part)) { font = 'Italic'; piece = part.slice(1, -1) }
    else if (/^`[^`]+`$/.test(part)) { font = 'Bold'; piece = part.slice(1, -1) }
    const opts = { continued: i < parts.length - 1, lineGap: LINE_GAP, align }
    if (i === 0) doc.font(font).text(piece, left + indent, doc.y, { ...opts, width: w - indent })
    else doc.font(font).text(piece, opts)
  })
}

const stripInline = (s) => String(s).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/`([^`]+)`/g, '$1')

function heading(doc, text, level) {
  const size = level === 3 ? 14 : 12
  ensureSpace(doc, size * 4)
  doc.moveDown(level === 3 ? 0.9 : 0.6)
  if (level === 3) {
    doc.save().rect(doc.page.margins.left, doc.y + 2, 3.5, size + 2).fill(ACCENT).restore()
    doc.font('Bold').fontSize(size).fillColor(NAVY).text(stripInline(text), doc.page.margins.left + 11, doc.y, { width: contentWidth(doc) - 11 })
  } else {
    doc.font('Bold').fontSize(size).fillColor(INK).text(stripInline(text), doc.page.margins.left, doc.y, { width: contentWidth(doc) })
  }
  doc.moveDown(0.35)
}

function listItem(doc, marker, text, depth) {
  const indent = 14 + depth * 16
  ensureSpace(doc, BODY * 2.2)
  const y = doc.y
  doc.font(marker === '•' ? 'Bold' : 'Body').fontSize(BODY).fillColor(ACCENT)
    .text(marker, doc.page.margins.left + indent - 12, y, { width: 14, lineBreak: false })
  doc.y = y
  richText(doc, text, { indent })
  doc.moveDown(0.25)
}

function callout(doc, lines) {
  const text = lines.join(' ')
  const w = contentWidth(doc) - 28
  doc.font('Body').fontSize(BODY)
  const h = doc.heightOfString(stripInline(text), { width: w, lineGap: LINE_GAP }) + 18
  ensureSpace(doc, h + 8)
  const top = doc.y + 4
  doc.save().roundedRect(doc.page.margins.left, top, contentWidth(doc), h, 6).fill('#fff4ec').restore()
  doc.save().rect(doc.page.margins.left, top, 3.5, h).fill(ACCENT).restore()
  doc.y = top + 9
  richText(doc, text, { x: doc.page.margins.left + 16, width: w + 4 })
  doc.y = top + h + 6
}

function codeBlock(doc, lines) {
  const text = lines.join('\n')
  doc.font('Courier').fontSize(9.4)
  const w = contentWidth(doc) - 20
  const h = doc.heightOfString(text, { width: w }) + 16
  ensureSpace(doc, Math.min(h, 300) + 8)
  const top = doc.y + 4
  doc.save().roundedRect(doc.page.margins.left, top, contentWidth(doc), h, 5).fill(TINT).restore()
  doc.fillColor(INK).text(text, doc.page.margins.left + 10, top + 8, { width: w })
  doc.y = Math.max(doc.y, top + h) + 6
}

function table(doc, rows) {
  const cells = rows.map((r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => stripInline(c.trim())))
  const body = cells.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''))
  if (!body.length) return
  const cols = Math.max(...body.map((r) => r.length))
  const total = contentWidth(doc)
  // Wider columns for longer text, within limits.
  const lens = Array.from({ length: cols }, (_, c) => Math.max(4, ...body.map((r) => (r[c] || '').length)))
  const sum = lens.reduce((a, b) => a + b, 0)
  const widths = lens.map((l) => Math.max(total * 0.12, (l / sum) * total))
  const scale = total / widths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < widths.length; i += 1) widths[i] *= scale
  const pad = 5
  doc.moveDown(0.3)
  body.forEach((row, ri) => {
    const isHead = ri === 0
    doc.font(isHead ? 'Bold' : 'Body').fontSize(9.6)
    const h = Math.max(...widths.map((w, c) => doc.heightOfString(row[c] || '', { width: w - pad * 2 }))) + pad * 2
    ensureSpace(doc, h)
    const top = doc.y
    let x = doc.page.margins.left
    widths.forEach((w, c) => {
      if (isHead) doc.save().rect(x, top, w, h).fill(NAVY).restore()
      else if (ri % 2 === 0) doc.save().rect(x, top, w, h).fill(TINT).restore()
      doc.save().lineWidth(0.5).strokeColor(RULE).rect(x, top, w, h).stroke().restore()
      doc.fillColor(isHead ? '#ffffff' : INK).font(isHead ? 'Bold' : 'Body').fontSize(9.6)
        .text(row[c] || '', x + pad, top + pad, { width: w - pad * 2 })
      x += w
    })
    doc.y = top + h
  })
  doc.x = doc.page.margins.left
  doc.moveDown(0.6)
}

// Renders one Markdown chapter at the current position.
function markdown(doc, md) {
  const lines = String(md).replace(/\r/g, '').split('\n')
  let i = 0
  let para = []
  const flush = () => {
    if (!para.length) return
    ensureSpace(doc, BODY * 3)
    richText(doc, para.join(' '))
    doc.moveDown(0.55)
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (!t) { flush(); i += 1; continue }
    if (t.startsWith('```')) {
      flush()
      const block = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) block.push(lines[i++])
      i += 1
      codeBlock(doc, block)
      continue
    }
    if (/^#{1,3}\s/.test(t)) { flush(); heading(doc, t.replace(/^#+\s*/, ''), 3); i += 1; continue }
    if (/^#{4,6}\s/.test(t)) { flush(); heading(doc, t.replace(/^#+\s*/, ''), 4); i += 1; continue }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush()
      ensureSpace(doc, 20)
      doc.moveDown(0.4)
      doc.save().lineWidth(0.6).strokeColor(RULE).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke().restore()
      doc.moveDown(0.6)
      i += 1
      continue
    }
    if (t.startsWith('|')) {
      flush()
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++].trim())
      table(doc, rows)
      continue
    }
    if (t.startsWith('>')) {
      flush()
      const block = []
      while (i < lines.length && lines[i].trim().startsWith('>')) block.push(lines[i++].trim().replace(/^>\s?/, ''))
      callout(doc, block)
      continue
    }
    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line)
    if (bullet) { flush(); listItem(doc, '•', bullet[2], Math.min(2, Math.floor(bullet[1].length / 2))); i += 1; continue }
    const numbered = /^(\s*)(\d+|[a-z])[.)]\s+(.*)$/i.exec(line)
    if (numbered) { flush(); listItem(doc, `${numbered[2]}.`, numbered[3], Math.min(2, Math.floor(numbered[1].length / 2))); i += 1; continue }
    para.push(t)
    i += 1
  }
  flush()
}

function cover(doc, notes) {
  doc.addPage({ ...PAGE, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
  const W = doc.page.width
  const H = doc.page.height
  doc.save().rect(0, 0, W, H * 0.56).fill(NAVY).restore()
  doc.save().rect(0, H * 0.56, W, 6).fill(ACCENT).restore()
  // logo on a white disc
  // The logo image is square with a white background: clip it to the disc.
  const r = 96
  doc.save().circle(W / 2, 175, r + 6).fill('#ffffff').restore()
  doc.save().circle(W / 2, 175, r).clip()
  doc.image(LOGO, W / 2 - r * 1.12, 175 - r * 1.12, { width: r * 2.24, height: r * 2.24 })
  doc.restore()
  doc.font('Bold').fontSize(11).fillColor('#c9d0f5').text('RCF MOUAU LIBRARY', 0, 300, { width: W, align: 'center', characterSpacing: 3 })
  doc.font('Bold').fontSize(38).fillColor('#ffffff').text(notes.courseCode || 'Lecture Notes', 50, 335, { width: W - 100, align: 'center' })
  doc.font('Bold').fontSize(20).fillColor('#ffffff').text(notes.courseTitle, 60, doc.y + 6, { width: W - 120, align: 'center' })
  doc.font('Body').fontSize(12).fillColor('#c9d0f5')
    .text(['Comprehensive Lecture Notes', notes.level && `${notes.level} Level`, notes.units && `${notes.units} Units`].filter(Boolean).join('  ·  '), 60, doc.y + 12, { width: W - 120, align: 'center' })

  const y0 = H * 0.56 + 60
  const row = (label, value, y) => {
    doc.font('Body').fontSize(10).fillColor(MUTED).text(label.toUpperCase(), 80, y, { characterSpacing: 1.5 })
    doc.font('Bold').fontSize(15).fillColor(INK).text(value, 80, y + 15, { width: W - 160 })
  }
  row('Author', 'RCF MOUAU', y0)
  row('Published by', 'Redeemed Christian Fellowship, MOUAU — Digital Library', y0 + 56)
  row('Contents', `${notes.chapters.length}-week scheme of work, worked examples, practice questions and a revision chapter`, y0 + 112)
  const date = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  doc.font('Italic').fontSize(8.6).fillColor(MUTED).text(
    `Prepared ${date} by the RCF MOUAU Library with AI assistance. Always read alongside your lecturer's course outline and recommended texts.`,
    80, H - 70, { width: W - 160, align: 'center' }
  )
}

function overview(doc, notes) {
  doc.addPage()
  doc.font('Bold').fontSize(22).fillColor(NAVY).text('Course Overview')
  doc.moveDown(0.5)
  if (notes.description) { richText(doc, notes.description); doc.moveDown(0.8) }
  if (notes.objectives.length) {
    heading(doc, 'What you will learn', 3)
    notes.objectives.forEach((o) => listItem(doc, '•', o, 0))
  }
  heading(doc, 'Scheme of Work', 3)
  table(doc, [
    '| Week | Topic | Subtopics |',
    '| --- | --- | --- |',
    ...notes.schemeOfWork.map((w) => `| ${w.week} | ${w.topic.replace(/\|/g, '/')} | ${w.subtopics.join('; ').replace(/\|/g, '/')} |`),
  ])
  if (notes.references.length) {
    heading(doc, 'Recommended Texts', 3)
    notes.references.forEach((r, i) => listItem(doc, `${i + 1}.`, r, 0))
  }
}

function chapterOpener(doc, kicker, title) {
  doc.addPage()
  doc.font('Bold').fontSize(10).fillColor(ACCENT).text(kicker.toUpperCase(), { characterSpacing: 2 })
  doc.font('Bold').fontSize(21).fillColor(NAVY).text(title, { lineGap: 2 })
  doc.save().rect(doc.page.margins.left, doc.y + 6, 56, 3).fill(ACCENT).restore()
  doc.moveDown(1.2)
}

function headersAndFooters(doc, notes) {
  const range = doc.bufferedPageRange()
  const label = `${notes.courseCode ? `${notes.courseCode} · ` : ''}${notes.courseTitle}`
  for (let p = 1; p < range.count; p += 1) {
    doc.switchToPage(range.start + p)
    const { left, right } = doc.page.margins
    const W = doc.page.width
    // pdfkit would add a page if we wrote below the bottom margin, so lift it while drawing.
    const savedBottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.image(LOGO, left, 26, { width: 26, height: 26 })
    doc.font('Bold').fontSize(8.5).fillColor(NAVY).text('RCF MOUAU', left + 32, 30, { lineBreak: false })
    doc.font('Body').fontSize(8.5).fillColor(MUTED).text(label, left + 100, 30, { width: W - left - right - 100, align: 'right', lineBreak: false, ellipsis: true })
    doc.save().lineWidth(0.6).strokeColor(RULE).moveTo(left, 58).lineTo(W - right, 58).stroke().restore()
    doc.save().lineWidth(0.6).strokeColor(RULE).moveTo(left, doc.page.height - 48).lineTo(W - right, doc.page.height - 48).stroke().restore()
    doc.font('Body').fontSize(8.5).fillColor(MUTED)
      .text('RCF MOUAU Digital Library', left, doc.page.height - 40, { lineBreak: false })
      .text(`Page ${p + 1} of ${range.count}`, left, doc.page.height - 40, { width: W - left - right, align: 'right', lineBreak: false })
    doc.page.margins.bottom = savedBottom
  }
}

// Returns a Buffer with the finished PDF.
export function renderNotesPdf(notes) {
  return new Promise((resolve, reject) => {
    const doc = setup()
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    try {
      doc.info.Title = `${notes.courseCode ? `${notes.courseCode} – ` : ''}${notes.courseTitle} (Lecture Notes)`
      doc.info.Author = 'RCF MOUAU'
      doc.info.Creator = 'RCF MOUAU Digital Library'
      doc.info.Subject = 'Comprehensive lecture notes'

      cover(doc, notes)
      overview(doc, notes)
      for (const ch of notes.chapters) {
        chapterOpener(doc, `Week ${ch.week}`, ch.topic)
        markdown(doc, ch.markdown)
      }
      if (notes.revision) {
        chapterOpener(doc, 'Revision', 'Summary, Glossary and Exam Practice')
        markdown(doc, notes.revision)
      }
      headersAndFooters(doc, notes)
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

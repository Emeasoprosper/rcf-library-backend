import { PDFDocument, rgb, degrees } from 'pdf-lib'

// Stamps a diagonal, semi-transparent watermark across every page —
// this is what runs on every PDF download, so downloaded copies always
// carry your branding even if someone gets the file off the device.
export async function watermarkPdf(buffer, text = 'RCF MOUAU LIBRARY') {
  const pdfDoc = await PDFDocument.load(buffer)
  const pages = pdfDoc.getPages()

  for (const page of pages) {
    const { width, height } = page.getSize()
    page.drawText(text, {
      x: width / 2 - (text.length * 6),
      y: height / 2,
      size: 36,
      color: rgb(0.6, 0.6, 0.6),
      opacity: 0.25,
      rotate: degrees(45),
    })
  }

  return Buffer.from(await pdfDoc.save())
}
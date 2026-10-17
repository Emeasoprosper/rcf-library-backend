// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/sitemap.js
import { Router } from 'express'
import { query } from '../db/pool.js'

const router = Router()
const APP_URL = (process.env.FRONTEND_URLS || '').split(',')[0]?.trim() || 'https://rcf-mouau-library.vercel.app'

router.get('/sitemap.xml', async (req, res) => {
  const result = await query(`SELECT id, updated_at, created_at FROM resources WHERE status = 'approved'`)
  const backendOrigin = `${req.protocol}://${req.get('host')}`

  const urls = result.rows
    .map((r) => {
      const lastmod = new Date(r.updated_at || r.created_at).toISOString().split('T')[0]
      return `  <url>\n    <loc>${APP_URL}/library/${r.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`
    })
    .join('\n')

  res.setHeader('Content-Type', 'application/xml')
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`)
})

router.get('/robots.txt', (req, res) => {
  const backendOrigin = `${req.protocol}://${req.get('host')}`
  res.setHeader('Content-Type', 'text/plain')
  res.send(`User-agent: *\nAllow: /library/\nAllow: /s/\nAllow: /api/resources\nDisallow: /api/\n\nSitemap: ${APP_URL}/sitemap.xml`)
})

export default router
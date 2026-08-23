// rcf-library-backend/src/routes/resourceCollections.js
import { Router } from 'express'
import { query } from '../db/pool.js'
import { attachUser } from '../middleware/auth.js'

const router = Router()

// GET /resource-collections — lightweight list for browse rails (Home,
// Search). No section/related data here — that's only fetched on the
// full collection page (GET /:id below) to keep this list cheap.
router.get('/', attachUser, async (req, res) => {
  // Falls back to the first approved resource's thumbnail when the
  // collection itself has no cover_url set yet — LATERAL picks one
  // per collection instead of a separate query per row.
  const result = await query(
    `SELECT c.id, c.title, c.author,
            COALESCE(c.cover_url, fallback.thumbnail_url) AS cover_url
     FROM resource_collections c
     LEFT JOIN LATERAL (
       SELECT thumbnail_url FROM resources
       WHERE collection_id = c.id AND status = 'approved' AND thumbnail_url IS NOT NULL
       ORDER BY created_at ASC LIMIT 1
     ) fallback ON true
     ORDER BY c.created_at DESC LIMIT 20`
  )
  res.json({ items: result.rows })
})

// GET /resource-collections/:id — full Spotify-style collection page data:
// header info + resources grouped by section, in section sort_order then
// each resource's own collection_sort_order. Sections with zero resources
// are still returned (empty array) so admin section-management UI can
// show/rename an empty section, not just ones already holding files.
router.get('/:id', attachUser, async (req, res) => {
  const collectionResult = await query(
    `SELECT id, title, author, description, cover_url FROM resource_collections WHERE id = $1`,
    [req.params.id]
  )
  if (collectionResult.rows.length === 0) return res.status(404).json({ error: 'Collection not found' })

  const sectionsResult = await query(
    `SELECT id, name, sort_order FROM resource_collection_sections
     WHERE collection_id = $1 ORDER BY sort_order ASC, name ASC`,
    [req.params.id]
  )

  const resourcesResult = await query(
    `SELECT r.id, r.title, r.thumbnail_url, r.thumbnail_status, r.chapter, r.part,
            r.volume, r.edition, r.file_type, r.collection_section_id, r.collection_sort_order,
            rt.slug AS type
     FROM resources r
     JOIN resource_types rt ON rt.id = r.resource_type_id
     WHERE r.collection_id = $1 AND r.status = 'approved'
     ORDER BY r.collection_sort_order ASC, r.chapter ASC NULLS LAST, r.created_at ASC`,
    [req.params.id]
  )

  // Group resources under their section — unsectioned resources
  // (collection_section_id IS NULL) go under a synthetic "Other" bucket
  // rather than being silently dropped from the page.
  const sectionMap = new Map(
    sectionsResult.rows.map((s) => [s.id, { id: s.id, name: s.name, resources: [] }])
  )
  const unsectioned = { id: null, name: 'Other', resources: [] }

  for (const r of resourcesResult.rows) {
    const bucket = r.collection_section_id ? sectionMap.get(r.collection_section_id) : unsectioned
    ;(bucket || unsectioned).resources.push(r)
  }

  const sections = [...sectionMap.values(), ...(unsectioned.resources.length ? [unsectioned] : [])]

  // Related resources: same category/tags/author as anything already in
  // this collection, via the resource_relations table populated at
  // submit-time — capped at 8, excludes anything already in the collection.
  const relatedResult = await query(
    `SELECT DISTINCT r.id, r.title, r.thumbnail_url, r.file_type, rt.slug AS type
     FROM resource_relations rr
     JOIN resources r ON r.id = rr.related_resource_id
     JOIN resource_types rt ON rt.id = r.resource_type_id
     WHERE rr.resource_id = ANY($1) AND r.collection_id IS DISTINCT FROM $2 AND r.status = 'approved'
     LIMIT 8`,
    [resourcesResult.rows.map((r) => r.id), req.params.id]
  )

  res.json({
    collection: collectionResult.rows[0],
    sections,
    related: relatedResult.rows,
  })
})

export default router
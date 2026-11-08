import { query } from '../db/pool.js'

// Material requests can come from WhatsApp: when Bro Paul can't find what
// someone asked for, he files it for the admins. Those people may have no
// library account, so user_id is optional and their WhatsApp id and name
// sit in details ({ source: 'whatsapp', whatsappId, whatsappName, group }).
// When an admin fulfils it, Bro Paul DMs them the link.
let ready = null

export function ensureWhatsappRequests() {
  ready ||= query(`ALTER TABLE material_requests ALTER COLUMN user_id DROP NOT NULL`).catch((err) => {
    ready = null
    throw err
  })
  return ready
}

export function isWhatsappRequest(details) {
  return details?.source === 'whatsapp' && typeof details.whatsappId === 'string'
}

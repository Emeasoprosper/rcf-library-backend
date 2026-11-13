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

export const SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://rcf-mouau-library.vercel.app').replace(/\/$/, '')

// Many ask for the file to be sent "raw" in the chat. Never a refusal: the
// link is presented as the better deal for them.
export const READ_OFFLINE_NOTE =
  `\n\n📥 Tap the link, sign in and hit download. It saves right inside the app, so you can read it anytime, even offline with zero data, and it won't eat your phone storage or get lost in chats.` +
  `\n📴 Try it: once it's downloaded, switch off your data and open the app. It'll be waiting for you in Downloads.` +
  `\n🤝 We share books through the app rather than as loose files so they stay safe and free for every RCFite, and the people who upload them keep sharing. If anything gives you trouble, just reply here and I'll walk you through it.`

// The DM Bro Paul sends when what someone asked for is now in the library.
export function readyMessage({ whatsappName, requestTitle, resourceId, resourceTitle, aiWritten = false }) {
  const name = whatsappName ? ` ${whatsappName.split(' ')[0]}` : ''
  if (!resourceId) {
    return `Good news${name}! 🎉 "${requestTitle}", which you asked for, has been added to the library. Search for it here: ${SITE_URL}/library${READ_OFFLINE_NOTE}`
  }
  const intro = aiWritten
    ? `Good news${name}! 🎉 You asked for "${requestTitle}", so we wrote full lecture notes for you: *${resourceTitle}* ✍️📚\nScheme of work, clear explanations, worked examples, practice questions with answers, and a revision chapter.`
    : `Good news${name}! 🎉 Remember you asked for "${requestTitle}"? It's now in the library: *${resourceTitle}*`
  return `${intro}\n👉 ${SITE_URL}/library/${resourceId}${READ_OFFLINE_NOTE}`
}

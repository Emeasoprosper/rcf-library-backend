// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/botSettings.js
// The WhatsApp bot's switches, shared by routes/bot.js (bot reads them) and
// routes/admin.js (superadmin edits them). Anything not saved yet falls
// back to these defaults, so a missing key never breaks the bot.
import { query } from '../db/pool.js'

export const BOT_SETTING_DEFAULTS = {
  chimeIn: true,
  welcomeNewMembers: true,
  birthdayWishes: true,
  newMonthWishes: true,
  reactions: true,
  answerUntagged: true,
  privateChats: true,
  morningPost: true,
  stickers: true,
  promoEveryHours: 48,
  activeFromHour: 7,
  activeToHour: 21,
  dailyAiLimit: 150,
  // Chat log (admin app > Chats): save conversations, how much space they
  // may use, and whether the oldest are deleted automatically when full.
  saveChats: true,
  chatLogLimitMb: 100,
  chatLogAutoDelete: true,
  // Answer voice notes with a spoken voice note (male voice).
  voiceReplies: true,
  // Book of the day only picks books with an open licence (public domain,
  // Creative Commons), i.e. ones added through the app's free-book search.
  featuredOnlyLicensed: false,
  // AI library (admin app > AI Library):
  // aiLectureNotes     - lecture notes asked for (app or WhatsApp) that the
  //                      library doesn't have are written by AI
  // aiNotesAutoPublish - those notes go live without review
  // askForMaterials    - past questions nobody has: ask the groups that
  //                      have "Ask for materials" switched on
  // autoUploadMaterials - files people send Bro Paul (DM, or in a group when
  //                      it's clearly for the library) are added by him
  // autoPublishUploads - those uploads go live without review
  aiLectureNotes: true,
  aiNotesAutoPublish: true,
  askForMaterials: true,
  autoUploadMaterials: true,
  autoPublishUploads: true,
}

const BOOL_KEYS = ['chimeIn', 'welcomeNewMembers', 'birthdayWishes', 'newMonthWishes', 'reactions', 'answerUntagged', 'privateChats', 'morningPost', 'stickers', 'saveChats', 'chatLogAutoDelete', 'voiceReplies', 'featuredOnlyLicensed', 'aiLectureNotes', 'aiNotesAutoPublish', 'askForMaterials', 'autoUploadMaterials', 'autoPublishUploads']
const INT_RANGES = {
  promoEveryHours: [0, 24 * 14],
  activeFromHour: [0, 23],
  activeToHour: [1, 24],
  dailyAiLimit: [0, 2000],
  chatLogLimitMb: [10, 2000],
}

// Keeps only known keys with sane values.
export function cleanBotSettings(input = {}) {
  const out = {}
  for (const key of BOOL_KEYS) if (typeof input[key] === 'boolean') out[key] = input[key]
  for (const [key, [min, max]] of Object.entries(INT_RANGES)) {
    const n = Number(input[key])
    if (input[key] !== undefined && Number.isInteger(n)) out[key] = Math.min(Math.max(n, min), max)
  }
  return out
}

export async function getBotSettings() {
  const result = await query(`SELECT settings FROM whatsapp_bot_settings WHERE id = 1`)
  return { ...BOT_SETTING_DEFAULTS, ...cleanBotSettings(result.rows[0]?.settings || {}) }
}

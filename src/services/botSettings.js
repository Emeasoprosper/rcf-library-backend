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
  promoEveryHours: 48,
  activeFromHour: 7,
  activeToHour: 21,
  dailyAiLimit: 150,
}

const BOOL_KEYS = ['chimeIn', 'welcomeNewMembers', 'birthdayWishes', 'newMonthWishes', 'reactions', 'answerUntagged', 'privateChats']
const INT_RANGES = {
  promoEveryHours: [0, 24 * 14],
  activeFromHour: [0, 23],
  activeToHour: [1, 24],
  dailyAiLimit: [0, 2000],
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

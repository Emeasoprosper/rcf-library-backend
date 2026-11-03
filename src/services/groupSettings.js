// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/groupSettings.js
// Per-group rules for the WhatsApp bot, set by a superadmin on the admin
// app's WhatsApp Bot page and read by the bot through /bot/groups:
//   audience - 'campus'  : MOUAU students, full academic help
//              'mixed'   : students and others; past questions only when
//                          asked, introduced as "for MOUAU students"
//              'general' : not a student group; never mentions past
//                          questions or lecture notes
//   the rest - which kinds of posts the bot may send there
import { query } from '../db/pool.js'

export const GROUP_SETTING_DEFAULTS = {
  audience: 'campus',
  bookOfDay: true,
  morningPost: true,
  promos: true,
  welcome: true,
  chimeIn: true,
  newMonth: true,
  birthdays: true,
}

const AUDIENCES = ['campus', 'mixed', 'general']
const BOOL_KEYS = ['bookOfDay', 'morningPost', 'promos', 'welcome', 'chimeIn', 'newMonth', 'birthdays']

// Keeps only known keys with sane values.
export function cleanGroupSettings(input = {}) {
  const out = {}
  if (AUDIENCES.includes(input.audience)) out.audience = input.audience
  for (const key of BOOL_KEYS) if (typeof input[key] === 'boolean') out[key] = input[key]
  return out
}

export const withGroupDefaults = (saved) => ({ ...GROUP_SETTING_DEFAULTS, ...cleanGroupSettings(saved || {}) })

// The settings column is added on first use, so no separate migration has to
// be run on the server. Safe to call any number of times.
let ensured = null
export function ensureGroupSettingsColumn() {
  ensured ||= query(`ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb`).catch((err) => {
    ensured = null
    throw err
  })
  return ensured
}

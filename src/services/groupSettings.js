// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/groupSettings.js
// Per-group rules for the WhatsApp bot, set by a superadmin on the admin
// app's WhatsApp Bot page and read by the bot through /bot/groups:
//   audience - 'campus'  : MOUAU students, full academic help
//              'mixed'   : students and others; past questions only when
//                          asked, introduced as "for MOUAU students"
//              'general' : not a student group; never mentions past
//                          questions or lecture notes
//   prayer   - during a prayer session: 'quiet', 'amen' (🙏 the prayers)
//              or 'join' (also adds a short prayer now and then)
//   revealAi - whether Bro Paul presents himself as an AI there (he never
//              claims to be human if sincerely asked)
//   started  - false for a group he was just added to: he stays silent
//              until a superadmin introduces him or starts him quietly
//   the rest - which kinds of posts the bot may send there
import { query } from '../db/pool.js'

export const GROUP_SETTING_DEFAULTS = {
  audience: 'campus',
  prayer: 'amen',
  revealAi: true,
  started: true,
  bookOfDay: true,
  morningPost: true,
  promos: true,
  welcome: true,
  chimeIn: true,
  newMonth: true,
  birthdays: true,
  // Ask this group for past questions the library doesn't have (and accept
  // files sent here as library material). Off until an admin picks the group.
  askForMaterials: false,
}

const AUDIENCES = ['campus', 'mixed', 'general']
const PRAYER_MODES = ['quiet', 'amen', 'join']
// studyTip has no default on purpose: until it's set, the bot shows the
// study tip in student groups and leaves it out of 'general' ones.
// left = Bro Paul was removed from the group (set by the bot, cleared when
// he's added back).
const BOOL_KEYS = ['bookOfDay', 'morningPost', 'studyTip', 'promos', 'welcome', 'chimeIn', 'newMonth', 'birthdays', 'revealAi', 'started', 'left', 'askForMaterials']

// Keeps only known keys with sane values.
export function cleanGroupSettings(input = {}) {
  const out = {}
  if (AUDIENCES.includes(input.audience)) out.audience = input.audience
  if (PRAYER_MODES.includes(input.prayer)) out.prayer = input.prayer
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

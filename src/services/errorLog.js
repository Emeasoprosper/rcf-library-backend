// Keeps the most recent server errors in memory for the admin inspector.
// Anything logged with console.error is captured; the original logging
// still happens. Cleared whenever the server restarts.
const MAX_ENTRIES = 100
const MAX_LENGTH = 4000
const entries = []

function stringify(value) {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const originalConsoleError = console.error.bind(console)

console.error = (...args) => {
  try {
    entries.unshift({
      at: new Date().toISOString(),
      message: args.map(stringify).join(' ').slice(0, MAX_LENGTH),
    })
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES
  } catch {
    // never let logging break the request
  }
  originalConsoleError(...args)
}

export function getRecentErrors() {
  return entries
}
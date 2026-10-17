// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/mailer.js
// Sends email through Brevo's HTTPS API. No SMTP ports are used, so it
// works on every Render plan.
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email'

export function mailerConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL)
}

export async function sendMail({ to, toName, subject, html, text }) {
  if (!mailerConfigured()) throw new Error('Email is not configured (BREVO_API_KEY or MAIL_FROM_EMAIL missing)')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME || 'RCF MOUAU Library' },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Brevo ${response.status}: ${body.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}
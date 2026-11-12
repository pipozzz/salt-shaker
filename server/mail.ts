import nodemailer from 'nodemailer'
import type { Message } from './summaries'

export { readRecipients } from '../src/lib/recipients'

/*
 * Email notifications: the same messages as the chat channels, as a plain email with a link
 * back. SMTP is set once for the server (SMTP_URL); a channel only lists who receives them.
 */

export interface Mail {
  to: string[]
  subject: string
  text: string
  html: string
}
export type SendMail = (mail: Mail) => Promise<void>

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The email for a message: the title as the subject, its lines, and a link to open it. */
export function mailFor(msg: Message, to: string[], publicUrl: string): Mail {
  const url = msg.path ? `${publicUrl}${msg.path}` : publicUrl
  const color = { info: '#3f3f46', warning: '#b45309', error: '#b91c1c' }[msg.severity]
  return {
    to,
    subject: msg.title,
    text: `${msg.title}\n\n${msg.lines.join('\n')}\n\nOpen in Salt Shaker: ${url}\n`,
    html: [
      `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;color:#18181b">`,
      `<p style="margin:0 0 12px;font-size:16px;font-weight:600;color:${color}">${escape(msg.title)}</p>`,
      ...msg.lines.map((l) => `<p style="margin:0 0 4px">${escape(l)}</p>`),
      `<p style="margin:16px 0 0"><a href="${escape(url)}" style="color:#0f766e">Open in Salt Shaker</a></p>`,
      `</div>`,
    ].join(''),
  }
}

/** Sends through the SMTP server in `url` (smtp:// or smtps://, with credentials if it needs them). */
export function smtpMailer(url: string, from: string): SendMail {
  const transport = nodemailer.createTransport(url)
  return async (m) => {
    await transport.sendMail({ from, to: m.to.join(', '), subject: m.subject, text: m.text, html: m.html })
  }
}

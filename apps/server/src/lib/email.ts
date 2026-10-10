import { createConnection, type Socket } from 'node:net'
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport'
import type { EmailConfig, EmailRecipient } from './email-config'
import { EmailError } from './email-error'
import { serverInitials } from '@huddle/contracts'

export const AUTH_EMAIL_EXPIRY_SECONDS = 300
export const SMTP_TIMEOUTS = {
  connection: 5_000,
  greeting: 5_000,
  socket: 10_000,
  operation: 15_000,
}

export type EmailMessage = { recipient: EmailRecipient; serverName: string } & (
  | { kind: 'installation-test' }
  | { kind: 'authentication-code'; code: string; purpose: 'sign-in' }
  | { kind: 'no-account' }
  | { kind: 'invitation'; inviter: string; expiresAt: string }
)

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
const font =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif"
const mono = "'SF Mono', ui-monospace, Menlo, Consolas, monospace"
const darkStyles = `:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .hd-page { background: #1c1c1c !important; }
  .hd-card { background: #161616 !important; border-color: #242424 !important; }
  .hd-line { border-color: #242424 !important; }
  .hd-text { color: #ededed !important; }
  .hd-muted { color: #8b8b8b !important; }
  .hd-faint { color: #6b6b6b !important; }
  .hd-box { background: #1f1f1f !important; border-color: #242424 !important; }
  .hd-field { background: #161616 !important; border-color: #2e2e2e !important; color: #ededed !important; }
  .hd-tile { background: #ededed !important; color: #161616 !important; }
  .hd-button { background: #3b82f6 !important; border-color: #3b82f6 !important; }
}`
const logo = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style="display:block"><mask id="hd-logo-cut"><rect width="24" height="24" fill="white"/><rect x="5.6" width="1.9" height="24" fill="black"/><rect x="16.5" width="1.9" height="24" fill="black"/><rect x="10.4" width="3.2" height="9.4" fill="black"/><rect x="10.4" y="14.6" width="3.2" height="9.4" fill="black"/></mask><circle cx="12" cy="12" r="12" fill="currentColor" mask="url(#hd-logo-cut)"/></svg>`
const clock = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="vertical-align:-2px;margin-right:6px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`

const paragraph = (html: string, tone: 'text' | 'muted' = 'muted') =>
  `<p class="hd-${tone}" style="margin:0 0 16px;font-size:14px;line-height:22px;color:${tone === 'text' ? '#171717' : '#7a7a7a'}">${html}</p>`
const strong = (html: string) => `<span class="hd-text" style="color:#171717">${html}</span>`
const box = (html: string, padding = '12px 14px') =>
  `<div class="hd-box" style="margin:0 0 16px;padding:${padding};background:#f5f5f5;border:1px solid #f0f0f0;border-radius:10px">${html}</div>`
const clockLine = (html: string) =>
  `<p class="hd-muted" style="margin:0 0 16px;font-size:13px;line-height:20px;color:#7a7a7a">${clock}${html}</p>`
const finePrint = (html: string) =>
  `<p class="hd-line hd-muted" style="margin:4px 0 0;padding-top:16px;border-top:1px solid #e7e7e7;font-size:12px;line-height:19px;color:#7a7a7a">${html}</p>`

function layout(serverName: string, footer: string, heading: string, content: string) {
  const name = escapeHtml(serverName)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(heading)}</title><style>${darkStyles}</style></head>
<body class="hd-page" style="margin:0;padding:0;background:#f4f4f4;font-family:${font}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="hd-page" style="background:#f4f4f4"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="hd-card" style="max-width:480px;background:#ffffff;border:1px solid #e7e7e7;border-radius:12px;border-collapse:separate">
<tr><td class="hd-line" style="padding:14px 24px;border-bottom:1px solid #e7e7e7">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="hd-text" style="color:#171717;padding-right:6px">${logo}</td>
<td class="hd-text" style="color:#171717;font-size:15px;font-weight:600;letter-spacing:-0.2px">huddle</td>
<td class="hd-faint" style="color:#a3a3a3;font-size:13px;padding:0 9px">/</td>
<td style="padding-right:7px"><span class="hd-tile" style="display:inline-block;min-width:16px;height:16px;padding:0 2px;box-sizing:border-box;border-radius:4px;background:#171717;color:#ffffff;font-size:7px;line-height:16px;font-weight:700;text-align:center;letter-spacing:0.2px">${escapeHtml(serverInitials(serverName))}</span></td>
<td class="hd-text" style="color:#171717;font-size:13px">${name}</td>
</tr></table>
</td></tr>
<tr><td style="padding:26px 24px 24px">
<h1 class="hd-text" style="margin:0 0 14px;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-0.3px;color:#171717">${escapeHtml(heading)}</h1>
${content}
</td></tr>
</table>
<p class="hd-faint" style="margin:24px 0 0;font-size:11px;line-height:16px;color:#a3a3a3">${escapeHtml(footer)}</p>
</td></tr></table>
</body></html>
`
}

const groupedCode = (code: string) =>
  /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
const utcMinute = (date: Date) =>
  `${date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  })} UTC`

type EmailContent = { subject: string; heading: string; html: string; text: string }
function emailContent(message: EmailMessage, serverUrl: string, host: string): EmailContent {
  const serverName = message.serverName
  const name = escapeHtml(serverName)
  switch (message.kind) {
    case 'installation-test':
      return {
        subject: `${serverName} email delivery test`,
        heading: 'Email delivery test',
        text: `This is an installation test from ${serverName} at ${host}.\n\nThe SMTP relay accepted this message. Inbox delivery depends on your email provider.`,
        html:
          paragraph(`This is an installation test from ${name} at ${escapeHtml(host)}.`, 'text') +
          paragraph(
            'The SMTP relay accepted this message. Inbox delivery depends on your email provider.',
          ),
      }
    case 'authentication-code': {
      const enter = `Enter this code to continue signing in to ${serverName}${serverName.endsWith('.') ? '' : '.'}`
      const expiry = `Expires in ${AUTH_EMAIL_EXPIRY_SECONDS / 60} minutes.`
      return {
        subject: `${serverName} authentication code`,
        heading: 'Your authentication code',
        text: `${enter}\n\n${message.code}\n\n${expiry}\n\nHuddle will never ask you for this code by chat or phone.\n\nIf you didn't try to sign in, you can ignore this email. Someone may have typed your address by mistake.`,
        html:
          paragraph(escapeHtml(enter)) +
          box(
            `<div class="hd-text" style="font-family:${mono};font-size:34px;line-height:44px;font-weight:700;letter-spacing:6px;text-align:center;color:#171717">${escapeHtml(groupedCode(message.code))}</div>`,
            '16px 14px',
          ) +
          clockLine(expiry) +
          paragraph('Huddle will never ask you for this code by chat or phone.') +
          finePrint(
            "If you didn't try to sign in, you can ignore this email. Someone may have typed your address by mistake.",
          ),
      }
    }
    case 'no-account': {
      const when = utcMinute(new Date())
      const row = (label: string, value: string, valueFont = font) =>
        `<tr><td class="hd-muted" style="padding:2px 14px 2px 0;font-size:13px;line-height:20px;color:#7a7a7a">${label}</td><td class="hd-text" style="padding:2px 0;font-family:${valueFont};font-size:13px;line-height:20px;color:#171717">${value}</td></tr>`
      return {
        subject: `Sign-in attempt at ${serverName}`,
        heading: "There's no account for this address",
        text: `Someone tried to sign in to ${serverName} with this email address, but there is no account for it.\n\nAccounts are created by invitation; ask an admin to invite you.\n\nServer: ${host}\nWhen: ${when}\n\nIf this wasn't you, you can ignore this email. Nothing has changed and no account was created.`,
        html:
          paragraph(
            `Someone tried to sign in to ${name} with this email address, but there is no account for it.`,
            'text',
          ) +
          paragraph('Accounts are created by invitation; ask an admin to invite you.') +
          box(
            `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${row('Server', escapeHtml(host), mono)}${row('When', escapeHtml(when))}</table>`,
          ) +
          finePrint(
            "If this wasn't you, you can ignore this email. Nothing has changed and no account was created.",
          ),
      }
    }
    case 'invitation': {
      const login = `${serverUrl}/login`
      const expires = new Date(message.expiresAt).toLocaleDateString('en-US', {
        dateStyle: 'medium',
        timeZone: 'UTC',
      })
      const invited = `${message.inviter} invited you to ${serverName}`
      const intro = `${serverName} uses Huddle for team chat. Accept to set up your account. It takes about two minutes.`
      return {
        subject: `${invited} on Huddle`,
        heading: invited,
        text: `${intro}\n\nAccept invitation: ${login}\n\nUsing the desktop app? Connect to this server address:\n${serverUrl}\nThen sign in with ${message.recipient}.\n\nThis invitation expires on ${expires}.\n\nIf you weren't expecting this, you can ignore this email. No account is created until you accept.`,
        html:
          paragraph(escapeHtml(intro)) +
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td class="hd-button" style="border-radius:8px;background:#1d4ed8;border:1px solid #1d4ed8"><a href="${escapeHtml(login)}" style="display:inline-block;padding:9px 16px;font-size:14px;line-height:20px;font-weight:500;color:#ffffff;text-decoration:none">Accept invitation</a></td></tr></table>` +
          box(
            `<p class="hd-muted" style="margin:0 0 8px;font-size:13px;line-height:18px;color:#7a7a7a">Using the desktop app? Connect to this server address:</p>` +
              `<div class="hd-field" style="margin:0 0 8px;padding:8px 10px;background:#ffffff;border:1px solid #e7e7e7;border-radius:6px;font-family:${mono};font-size:13px;line-height:18px;color:#171717;user-select:all;-webkit-user-select:all;word-break:break-all">${escapeHtml(serverUrl)}</div>` +
              `<p class="hd-muted" style="margin:0;font-size:12px;line-height:18px;color:#7a7a7a">Then sign in with ${strong(escapeHtml(message.recipient))}.</p>`,
          ) +
          clockLine(`This invitation expires on ${strong(escapeHtml(expires))}.`) +
          finePrint(
            "If you weren't expecting this, you can ignore this email. No account is created until you accept.",
          ),
      }
    }
    default: {
      const exhaustive: never = message
      return exhaustive
    }
  }
}
function renderEmail(message: EmailMessage, serverUrl: string) {
  const host = new URL(serverUrl).host
  const footer = `Sent by the Huddle server at ${host} · ${message.serverName}`
  const { subject, heading, html, text } = emailContent(message, serverUrl, host)
  return {
    subject,
    text: `${heading}\n\n${text}\n\n--\n${footer}\n`,
    html: layout(message.serverName, footer, heading, html),
  }
}
function transportError(error: unknown): EmailError {
  if (error instanceof EmailError) return error
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'ETIMEDOUT') return new EmailError('timeout')
    if (error.code === 'EENVELOPE' || error.code === 'EMESSAGE') return new EmailError('rejected')
  }
  return new EmailError('unavailable')
}

export function createEmailSender(email: EmailConfig, serverUrl: string) {
  return async (message: EmailMessage): Promise<void> => {
    if (email.kind === 'disabled') throw new EmailError('disabled')
    const { default: nodemailer } = await import('nodemailer')
    let socket: Socket | undefined
    const options: SMTPTransportOptions = {
      getSocket: (_options, callback) => {
        const connection = createConnection({ host: email.host, port: email.port })
        socket = connection
        const failed = (error: Error) => callback(error)
        connection.once('error', failed)
        connection.setTimeout(SMTP_TIMEOUTS.connection, () =>
          connection.destroy(new EmailError('timeout')),
        )
        connection.once('connect', () => {
          connection.removeListener('error', failed)
          connection.setTimeout(0)
          callback(null, { connection })
        })
      },
      host: email.host,
      port: email.port,
      secure: email.security.kind === 'tls',
      requireTLS: email.security.kind === 'starttls',
      ignoreTLS: email.security.kind === 'local',
      auth: email.credentials.kind === 'authenticated' ? email.credentials : undefined,
      connectionTimeout: SMTP_TIMEOUTS.connection,
      greetingTimeout: SMTP_TIMEOUTS.greeting,
      socketTimeout: SMTP_TIMEOUTS.socket,
      tls: { rejectUnauthorized: true },
      logger: false,
      debug: false,
    }
    const transport = nodemailer.createTransport(options)
    let timer: NodeJS.Timeout | undefined
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          socket?.destroy()
          transport.close()
          reject(new EmailError('timeout'))
        }, SMTP_TIMEOUTS.operation)
      })
      const result = await Promise.race([
        transport.sendMail({
          from: {
            name:
              email.serverName === message.serverName
                ? email.serverName
                : `${email.serverName} · ${message.serverName}`,
            address: email.from,
          },
          to: message.recipient,
          ...renderEmail(message, serverUrl),
        }),
        deadline,
      ])
      const accepted = result.accepted.some(
        (recipient) => recipient.toLowerCase() === message.recipient.toLowerCase(),
      )
      if (!accepted) throw new EmailError('rejected')
    } catch (error) {
      throw transportError(error)
    } finally {
      clearTimeout(timer)
      socket?.destroy()
      transport.close()
    }
  }
}

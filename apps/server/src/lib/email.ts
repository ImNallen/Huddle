import { createConnection, type Socket } from 'node:net'
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport'
import type { EmailOTPOptions } from 'better-auth/plugins/email-otp'
import type { EmailConfig, EmailRecipient } from './email-config'
import { EmailError } from './email-error'

export const AUTH_EMAIL_EXPIRY_SECONDS = 300
export const SMTP_TIMEOUTS = {
  connection: 5_000,
  greeting: 5_000,
  socket: 10_000,
  operation: 15_000,
}

type AuthEmailPurpose = Parameters<EmailOTPOptions['sendVerificationOTP']>[0]['type']
export type EmailMessage =
  | { kind: 'installation-test'; recipient: EmailRecipient }
  | {
      kind: 'authentication-code'
      recipient: EmailRecipient
      code: string
      purpose: AuthEmailPurpose
    }

const purposes: Record<AuthEmailPurpose, string> = {
  'sign-in': 'sign in',
  'change-email': 'change your email address',
  'email-verification': 'verify your email address',
  'forget-password': 'reset your password',
}
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
function renderEmail(message: EmailMessage, serverName: string, serverUrl: string) {
  const identity = `${serverName} (${serverUrl})`
  switch (message.kind) {
    case 'installation-test':
      return {
        subject: `${serverName} email delivery test`,
        text: `This is an installation test from ${identity}.\n\nThe SMTP relay accepted this message. Inbox delivery depends on your email provider.\n`,
        html: `<p>This is an installation test from ${escapeHtml(identity)}.</p><p>The SMTP relay accepted this message. Inbox delivery depends on your email provider.</p>`,
      }
    case 'authentication-code': {
      const action = purposes[message.purpose]
      const expiry = AUTH_EMAIL_EXPIRY_SECONDS / 60
      return {
        subject: `${serverName} authentication code`,
        text: `Your code to ${action} on ${identity} is:\n\n${message.code}\n\nThis code expires in ${expiry} minutes. If you did not request it, ignore this email.\n`,
        html: `<p>Your code to ${action} on ${escapeHtml(identity)} is:</p><p><strong>${escapeHtml(message.code)}</strong></p><p>This code expires in ${expiry} minutes. If you did not request it, ignore this email.</p>`,
      }
    }
    default: {
      const exhaustive: never = message
      return exhaustive
    }
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
          from: { name: email.serverName, address: email.from },
          to: message.recipient,
          ...renderEmail(message, email.serverName, serverUrl),
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

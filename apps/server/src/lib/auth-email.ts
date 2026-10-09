import type { EmailOTPOptions } from 'better-auth/plugins/email-otp'
import { z } from 'zod'
import { emailRecipient } from './email-config'
import { EmailError } from './email-error'
import type { createEmailSender } from './email'

export const AUTH_EMAIL_COOLDOWN_MS = 60_000
export const AUTH_EMAIL_MAX_RECIPIENTS = 10_000
const Code = z.string().min(1).max(128)

export function createAuthEmailCallback(send: ReturnType<typeof createEmailSender>) {
  const reservations = new Map<string, number>()
  const callback: EmailOTPOptions['sendVerificationOTP'] = async ({ email, otp, type }) => {
    const recipient = emailRecipient(email)
    const code = Code.safeParse(otp)
    if (!code.success) throw new EmailError('configuration', 'authentication code')
    const now = Date.now()
    for (const [key, expires] of reservations) {
      if (expires <= now) reservations.delete(key)
    }
    const key = recipient.toLowerCase()
    if (reservations.has(key) || reservations.size >= AUTH_EMAIL_MAX_RECIPIENTS)
      throw new EmailError('rate-limit')
    reservations.set(key, now + AUTH_EMAIL_COOLDOWN_MS)
    await send({ kind: 'authentication-code', recipient, code: code.data, purpose: type })
  }
  return callback
}

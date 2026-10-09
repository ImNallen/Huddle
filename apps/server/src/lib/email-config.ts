import { z } from 'zod'
import { EmailError } from './email-error'

export const EmailRecipient = z.email().max(254).brand<'EmailRecipient'>()
export type EmailRecipient = z.infer<typeof EmailRecipient>

const SmtpEnvironment = z.object({
  SMTP_HOST: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_SECURITY: z.enum(['local', 'starttls', 'tls']),
  SMTP_FROM: EmailRecipient,
  SMTP_USERNAME: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_SERVER_NAME: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\r\n\x00-\x1f\x7f]+$/)
    .default('Huddle'),
})

type Credentials = { kind: 'anonymous' } | { kind: 'authenticated'; user: string; pass: string }
type Security = { kind: 'local' } | { kind: 'starttls' } | { kind: 'tls' }
export type EmailConfig =
  | { kind: 'disabled' }
  | {
      kind: 'smtp'
      host: string
      port: number
      security: Security
      credentials: Credentials
      from: EmailRecipient
      serverName: string
    }

export function parseEmailConfig(env: NodeJS.ProcessEnv): EmailConfig {
  const fields = Object.keys(SmtpEnvironment.shape)
  if (!fields.some((field) => env[field] !== undefined)) return { kind: 'disabled' }
  const parsed = SmtpEnvironment.safeParse(env)
  if (!parsed.success)
    throw new EmailError('configuration', String(parsed.error.issues[0]?.path[0] ?? 'SMTP'))
  const smtp = parsed.data
  if ((smtp.SMTP_USERNAME === undefined) !== (smtp.SMTP_PASSWORD === undefined))
    throw new EmailError('configuration', 'SMTP_USERNAME and SMTP_PASSWORD')
  if (
    smtp.SMTP_SECURITY === 'local' &&
    (env.NODE_ENV !== 'development' ||
      !['localhost', '127.0.0.1', '::1', 'mailpit'].includes(smtp.SMTP_HOST))
  )
    throw new EmailError('configuration', 'SMTP_SECURITY, SMTP_HOST and NODE_ENV')
  return {
    kind: 'smtp',
    host: smtp.SMTP_HOST,
    port: smtp.SMTP_PORT,
    security: { kind: smtp.SMTP_SECURITY },
    credentials:
      smtp.SMTP_USERNAME !== undefined && smtp.SMTP_PASSWORD !== undefined
        ? { kind: 'authenticated', user: smtp.SMTP_USERNAME, pass: smtp.SMTP_PASSWORD }
        : { kind: 'anonymous' },
    from: smtp.SMTP_FROM,
    serverName: smtp.SMTP_SERVER_NAME,
  }
}

export function emailRecipient(input: unknown): EmailRecipient {
  const recipient = EmailRecipient.safeParse(input)
  if (!recipient.success) throw new EmailError('configuration', 'recipient')
  return recipient.data
}

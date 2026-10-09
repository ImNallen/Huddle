export type EmailErrorKind =
  | 'disabled'
  | 'configuration'
  | 'unavailable'
  | 'rejected'
  | 'timeout'
  | 'rate-limit'

const messages: Record<EmailErrorKind, string> = {
  disabled: 'Email is disabled. Configure SMTP before sending.',
  configuration: 'Email configuration or message input is invalid.',
  unavailable: 'The SMTP relay is unavailable or could not establish a trusted connection.',
  rejected: 'The SMTP relay did not accept the requested recipient.',
  timeout: 'SMTP delivery timed out. Relay acceptance is unconfirmed.',
  'rate-limit': 'Email recipient cooldown or capacity limit reached.',
}

export class EmailError extends Error {
  constructor(
    readonly kind: EmailErrorKind,
    field?: string,
  ) {
    super(`${messages[kind]}${field ? ` Check ${field}.` : ''}`)
    this.name = 'EmailError'
  }
}

export function emailDiagnostic(error: unknown) {
  return error instanceof EmailError
    ? `Email failed (${error.kind}). ${error.message}`
    : 'Email failed (unavailable). Relay acceptance is unconfirmed.'
}

import { emailDiagnostic } from '../src/lib/email-error'

try {
  if (process.argv.length !== 3) throw new Error('usage')
  const { emailRecipient } = await import('../src/lib/email-config')
  const recipient = emailRecipient(process.argv[2])
  const { config } = await import('../src/lib/config')
  const { createEmailSender } = await import('../src/lib/email')
  await createEmailSender(
    config.EMAIL,
    config.SERVER_URL,
  )({
    kind: 'installation-test',
    recipient,
    serverName: config.EMAIL.kind === 'smtp' ? config.EMAIL.serverName : 'Huddle',
  })
  process.stdout.write(
    'SMTP relay accepted the requested recipient. Inbox delivery is not confirmed.\n',
  )
} catch (error) {
  if (process.argv.length !== 3)
    process.stderr.write('Usage: pnpm --silent email:test recipient@example.com\n')
  else process.stderr.write(`${emailDiagnostic(error)}\n`)
  process.exitCode = 1
}

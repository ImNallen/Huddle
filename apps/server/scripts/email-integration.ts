import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { emailRecipient, parseEmailConfig } from '../src/lib/email-config'
import { EmailError, emailDiagnostic } from '../src/lib/email-error'
import { createEmailSender, SMTP_TIMEOUTS, AUTH_EMAIL_EXPIRY_SECONDS } from '../src/lib/email'
import { smtpFixture, type FixtureMode } from './smtp-fixture'

const run = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), 'huddle-email-'))
const recipient = emailRecipient(`${randomUUID()}@huddle.test`)
const smtpHost = process.env.TEST_SMTP_HOST ?? '127.0.0.1'
const smtpPort = process.env.TEST_SMTP_PORT ?? '1025'
const mailpitUrl = process.env.TEST_MAILPIT_URL ?? 'http://127.0.0.1:8025'
const localEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  SMTP_HOST: smtpHost,
  SMTP_PORT: smtpPort,
  SMTP_SECURITY: 'local',
  SMTP_FROM: 'sender@huddle.test',
  SMTP_SERVER_NAME: 'Huddle <team> & "friends"',
}
delete localEnv.SMTP_USERNAME
delete localEnv.SMTP_PASSWORD

async function cli(env: NodeJS.ProcessEnv, args: string[] = [recipient]) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/email-test.ts', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), SMTP_TIMEOUTS.operation + 10_000)
  try {
    const [code] = await once(child, 'exit')
    assert.ok(!output.includes(recipient), 'CLI diagnostic must omit the recipient')
    assert.ok(
      !output.includes('fixture-sensitive'),
      'CLI diagnostic must omit SMTP response secrets',
    )
    return { code, output }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}
async function expectedFailure(operation: Promise<unknown>, kind: EmailError['kind']) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof EmailError, 'Failure must have a sanitized typed error')
    assert.equal(error.kind, kind)
    assert.ok(!emailDiagnostic(error).includes(recipient))
    assert.ok(!emailDiagnostic(error).includes('fixture-sensitive'))
    assert.equal(error.cause, undefined)
    return true
  })
}
async function captured() {
  const response = await fetch(`${mailpitUrl}/api/v1/messages`, {
    signal: AbortSignal.timeout(5000),
  })
  assert.ok(response.ok)
  const list = z
    .object({
      messages: z.array(
        z.object({
          ID: z.string(),
          To: z.array(z.object({ Address: z.string() })),
        }),
      ),
    })
    .parse(await response.json())
  const ids = list.messages.filter((message) => message.To.some((to) => to.Address === recipient))
  return Promise.all(
    ids.map(async ({ ID }) => {
      const detail = await fetch(`${mailpitUrl}/api/v1/message/${ID}`, {
        signal: AbortSignal.timeout(5000),
      })
      assert.ok(detail.ok)
      return z
        .object({
          Text: z.string(),
          HTML: z.string(),
          Subject: z.string(),
          From: z.object({ Name: z.string(), Address: z.string() }),
        })
        .parse(await detail.json())
    }),
  )
}

let stage = 'configuration'
try {
  assert.deepEqual(parseEmailConfig({}), { kind: 'disabled' })
  for (const bad of [
    { SMTP_PASSWORD: 'fixture-sensitive-password' },
    { ...localEnv, SMTP_USERNAME: 'fixture-sensitive-user' },
    { ...localEnv, SMTP_SECURITY: 'false' },
    { ...localEnv, SMTP_FROM: 'bad\r\nBcc: victim@example.com' },
    { ...localEnv, SMTP_SERVER_NAME: 'bad\nsubject' },
    { ...localEnv, SMTP_HOST: 'remote.example.com' },
    { ...localEnv, NODE_ENV: 'production' },
    { ...localEnv, NODE_ENV: undefined },
  ])
    assert.throws(
      () => parseEmailConfig(bad),
      (error: unknown) =>
        error instanceof EmailError &&
        error.kind === 'configuration' &&
        !error.message.includes('fixture-sensitive'),
    )
  assert.equal(parseEmailConfig({ ...localEnv, SMTP_HOST: 'mailpit' }).kind, 'smtp')
  await expectedFailure(
    createEmailSender(
      { kind: 'disabled' },
      'https://huddle.test',
    )({
      kind: 'installation-test',
      recipient,
    }),
    'disabled',
  )
  stage = 'Mailpit delivery and capture'
  const sent = await cli(localEnv)
  assert.equal(sent.code, 0, 'Real Mailpit CLI must succeed')
  assert.ok(sent.output.includes('SMTP relay accepted the requested recipient'))
  const rootCommand = await run('pnpm', ['--silent', 'email:test', recipient], {
    cwd: '../..',
    env: localEnv,
    timeout: SMTP_TIMEOUTS.operation + 10_000,
  })
  assert.ok(!rootCommand.stdout.includes(recipient), 'Root command stdout must omit the recipient')
  assert.ok(!rootCommand.stderr.includes(recipient), 'Root command stderr must omit the recipient')
  assert.equal(
    rootCommand.stdout.trim(),
    'SMTP relay accepted the requested recipient. Inbox delivery is not confirmed.',
  )
  assert.ok(
    !rootCommand.stderr.includes('fixture-sensitive'),
    'Root command stderr must omit SMTP response secrets',
  )
  await createEmailSender(
    parseEmailConfig(localEnv),
    'https://huddle.test',
  )({
    kind: 'authentication-code',
    recipient,
    code: 'fixture-sensitive-code<&>',
    purpose: 'sign-in',
  })
  const messages = await captured()
  assert.equal(messages.length, 3, 'Both CLI commands and the authentication message must deliver')
  const login = messages.find((message) => message.Subject.endsWith('authentication code'))
  assert.ok(login)
  assert.ok(login.Text.includes('fixture-sensitive-code<&>'))
  assert.ok(login.Text.includes('https://huddle.test'))
  assert.ok(login.Text.includes(`${AUTH_EMAIL_EXPIRY_SECONDS / 60} minutes`))
  assert.ok(login.HTML.includes('fixture-sensitive-code&lt;&amp;&gt;'))
  assert.ok(login.HTML.includes('Huddle &lt;team&gt; &amp; &quot;friends&quot;'))
  assert.ok(!login.HTML.includes('fixture-sensitive-code<&>'))
  assert.equal(login.From.Address, localEnv.SMTP_FROM)
  assert.equal(login.From.Name, localEnv.SMTP_SERVER_NAME)
  const invalid = await cli(localEnv, ['bad\r\nBcc: victim@example.com'])
  assert.notEqual(invalid.code, 0)
  assert.ok(!invalid.output.includes('victim@example.com'))
  assert.notEqual((await cli(localEnv, [])).code, 0)
  assert.notEqual((await cli(localEnv, [recipient, recipient])).code, 0)
  const disabledEnv = { ...process.env }
  for (const key of Object.keys(disabledEnv)) if (key.startsWith('SMTP_')) delete disabledEnv[key]
  const disabled = await cli(disabledEnv)
  assert.notEqual(disabled.code, 0)
  assert.ok(disabled.output.includes('(disabled)'))
  stage = 'SMTP failures'
  for (const mode of ['reject', 'drop', 'greeting-timeout', 'deadline'] satisfies FixtureMode[]) {
    stage = `SMTP failure ${mode}`
    const fixture = await smtpFixture(mode)
    try {
      const env = { ...localEnv, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(fixture.port) }
      const kind = mode === 'reject' ? 'rejected' : mode === 'drop' ? 'unavailable' : 'timeout'
      const start = Date.now()
      await expectedFailure(
        createEmailSender(
          parseEmailConfig(env),
          'https://huddle.test',
        )({
          kind: 'installation-test',
          recipient,
        }),
        kind,
      )
      if (mode === 'deadline') {
        assert.ok(Date.now() - start >= SMTP_TIMEOUTS.operation - 200)
        assert.ok(Date.now() - start < SMTP_TIMEOUTS.operation + 2000)
      }
      await delay(100)
      assert.equal(fixture.closes, fixture.connections, 'Failed operation must close SMTP socket')
      if (mode === 'reject') {
        assert.notEqual((await cli(env)).code, 0)
      }
    } finally {
      await fixture.close()
    }
  }
  const closed = await smtpFixture('accept')
  const closedPort = closed.port
  await closed.close()
  const unavailable = await cli({ ...localEnv, SMTP_PORT: String(closedPort) })
  assert.notEqual(unavailable.code, 0)
  assert.ok(unavailable.output.includes('(unavailable)'))
  stage = 'certificate generation'
  const certificate = { cert: join(directory, 'cert.pem'), key: join(directory, 'key.pem') }
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    certificate.key,
    '-out',
    certificate.cert,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
  ])
  for (const mode of ['starttls', 'tls'] satisfies FixtureMode[]) {
    stage = `TLS ${mode}`
    const fixture = await smtpFixture(mode, certificate)
    try {
      const env = {
        ...localEnv,
        NODE_ENV: 'production',
        SMTP_HOST: 'localhost',
        SMTP_PORT: String(fixture.port),
        SMTP_SECURITY: mode,
        NODE_EXTRA_CA_CERTS: certificate.cert,
      }
      assert.equal((await cli(env)).code, 0, `Trusted ${mode} must deliver`)
      assert.equal(fixture.messages.length, 1)
      assert.ok(fixture.messages[0]?.includes('Content-Type: multipart/alternative'))
      const untrusted = { ...env, NODE_EXTRA_CA_CERTS: '' }
      assert.notEqual((await cli(untrusted)).code, 0, `Untrusted ${mode} must fail`)
      assert.notEqual(
        (await cli({ ...env, SMTP_HOST: '127.0.0.1' })).code,
        0,
        'TLS must verify hostname',
      )
      assert.equal(fixture.messages.length, 1, 'Rejected TLS must not send payload')
    } finally {
      await fixture.close()
    }
  }
  const noTls = await smtpFixture('accept')
  try {
    assert.notEqual(
      (
        await cli({
          ...localEnv,
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: String(noTls.port),
          SMTP_SECURITY: 'starttls',
          NODE_ENV: 'production',
        })
      ).code,
      0,
      'Mandatory STARTTLS must reject a plaintext-only relay',
    )
    assert.equal(noTls.messages.length, 0)
  } finally {
    await noTls.close()
  }
  stage = 'setup preservation'
  const setupDir = join(directory, 'setup')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(setupDir, 'scripts'), { recursive: true })
  await writeFile(join(setupDir, 'scripts/setup.mjs'), await readFile('../../scripts/setup.mjs'))
  const existing = Buffer.from('KEEP=fixture-sensitive-password\r\nEXISTING=value\n')
  await writeFile(join(setupDir, '.env'), existing)
  await run(process.execPath, [join(setupDir, 'scripts/setup.mjs')])
  assert.deepEqual(
    await readFile(join(setupDir, '.env')),
    existing,
    'setup must preserve existing bytes',
  )
  await rm(join(setupDir, '.env'))
  await run(process.execPath, [join(setupDir, 'scripts/setup.mjs')])
  const fresh = await readFile(join(setupDir, '.env'), 'utf8')
  assert.equal(
    parseEmailConfig(
      Object.fromEntries(
        fresh
          .trim()
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => {
            const index = line.indexOf('=')
            return [line.slice(0, index), line.slice(index + 1)]
          }),
      ),
    ).kind,
    'smtp',
    'fresh setup must enable local Mailpit',
  )
  stage = 'unregistered email OTP route'
  const { auth } = await import('../src/lib/auth')
  const { db } = await import('../src/lib/db')
  try {
    const response = await auth.handler(
      new Request(`${process.env.SERVER_URL}/api/auth/sign-in/email-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: recipient, otp: 'synthetic' }),
      }),
    )
    assert.equal(response.status, 404, 'Email-only full-session route must stay unavailable')
  } finally {
    await db.end()
  }
  process.stdout.write(
    'Email integration passed: real SMTP, TLS, capture, setup preservation, bounded failures, safe diagnostics and inactive email OTP.\n',
  )
} catch {
  process.stderr.write(
    `Email integration failed during ${stage}. Captured content and SMTP errors are omitted.\n`,
  )
  process.exitCode = 1
} finally {
  await rm(directory, { recursive: true, force: true })
}

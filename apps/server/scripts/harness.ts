import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { TOTP } from 'otpauth'
import { AccessError, AccessView, type AccessCommand, type AccessStage } from '@huddle/contracts'

const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025'
const serverRoot = fileURLToPath(new URL('..', import.meta.url))

export async function scratchDatabase() {
  const adminUrl = z.string().parse(process.env.DATABASE_URL)
  const name = `huddle_scratch_${randomBytes(6).toString('hex')}`
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  return {
    name,
    url: url.href,
    async drop() {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    },
  }
}
export async function migrate(databaseUrl: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const [code] = await once(child, 'exit')
  return { code: z.number().parse(code), output }
}
export async function migratedDatabase() {
  const database = await scratchDatabase()
  const result = await migrate(database.url)
  if (result.code !== 0) {
    await database.drop()
    throw new Error(`Scratch migration failed: ${result.output}`)
  }
  return database
}

export type ServerProcess = Awaited<ReturnType<typeof startServer>>
export async function startServer(options: {
  databaseUrl: string
  port: number
  entry?: string
  env?: NodeJS.ProcessEnv
}) {
  const origin = `http://localhost:${options.port}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: process.env.SMTP_SECURITY === 'local' ? 'development' : 'test',
    DATABASE_URL: options.databaseUrl,
    PORT: String(options.port),
    WS_PORT: String(options.port + 1),
    SERVER_URL: origin,
    WS_PUBLIC_URL: `ws://localhost:${options.port + 1}`,
    ...options.env,
  }
  let child: ChildProcess | undefined
  let logs = ''
  async function start() {
    logs = ''
    child = spawn(process.execPath, ['--import', 'tsx', options.entry ?? 'runtime/production.ts'], {
      cwd: serverRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (chunk: Buffer) => (logs += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()))
    for (let attempt = 0; attempt < 160; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited. ${logs}`)
      const healthy = await fetch(`${origin}/api/health`).then(
        (response) => response.ok,
        () => false,
      )
      if (healthy) return
      await delay(125)
    }
    throw new Error(`Server startup timed out. ${logs}`)
  }
  async function stop() {
    if (!child || child.exitCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
    child = undefined
  }
  await start()
  return { origin, websocket: `ws://localhost:${options.port + 1}`, start, stop, logs: () => logs }
}

export async function startOidcFixture(port: number, identity: { sub: string; email: string }) {
  const issuer = `http://127.0.0.1:${port}`
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../../tests/fixtures/oidc-provider.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        OIDC_FIXTURE_PORT: String(port),
        OIDC_FIXTURE_ISSUER: issuer,
        OIDC_FIXTURE_SUBJECT: identity.sub,
        OIDC_FIXTURE_EMAIL: identity.email,
      },
      stdio: 'ignore',
    },
  )
  const discovery = `${issuer}/.well-known/openid-configuration`
  async function started() {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) return false
      if (
        await fetch(discovery).then(
          (response) => response.ok,
          () => false,
        )
      )
        return true
      await delay(100)
    }
    return false
  }
  if (!(await started())) {
    child.kill('SIGTERM')
    throw new Error(`OIDC fixture did not start on ${issuer}`)
  }
  async function control(path: 'identity' | 'mode', body: Record<string, string>) {
    const response = await fetch(`${issuer}/__fixture/${path}`, {
      method: 'POST',
      body: new URLSearchParams(body),
    })
    assert.equal(response.status, 200, `OIDC fixture accepts ${path} ${JSON.stringify(body)}`)
  }
  return {
    issuer,
    serverEnv: {
      OIDC_DISCOVERY_URL: discovery,
      OIDC_CLIENT_ID: 'huddle-test',
      OIDC_CLIENT_SECRET: 'huddle-test-secret',
    },
    identity: (sub: string, email: string) => control('identity', { sub, email }),
    mode: (mode: string) => control('mode', { mode }),
    async stop() {
      if (child.exitCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    },
  }
}

export class Client {
  cookies = new Map<string, string>()
  token = ''
  continuation = ''
  constructor(
    readonly origin: string,
    readonly native = false,
  ) {}
  async call(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(new URL(path, this.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: this.origin,
        'Content-Type': 'application/json',
        Cookie: this.cookie(),
        ...(this.native
          ? { 'X-Huddle-Client': 'native', 'X-Huddle-Continuation': this.continuation }
          : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? ''
      const index = pair.indexOf('=')
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    const value: unknown = await response.json().catch(() => null)
    const view = AccessView.safeParse(value)
    if (view.success) {
      this.token = view.data.bearerToken ?? this.token
      this.continuation = view.data.continuation ?? this.continuation
    }
    return { response, value }
  }
  async act(command: AccessCommand) {
    const { response, value } = await this.call('/api/access', command)
    assert.equal(response.status, 200, `${command.kind}: ${JSON.stringify(value)}`)
    return AccessView.parse(value)
  }
  cookie() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ')
  }
  sessionToken() {
    const encoded = [...this.cookies].find(([key]) => key.endsWith('session_token'))?.[1]
    if (this.native || !encoded) return this.token
    return decodeURIComponent(encoded)
  }
}

const MailList = z.object({
  messages: z.array(
    z.object({
      ID: z.string(),
      Subject: z.string(),
      To: z.array(z.object({ Address: z.string() })),
    }),
  ),
})
export async function mailIds(address: string) {
  const list = MailList.parse(await (await fetch(`${mailpit}/api/v1/messages`)).json())
  return new Set(
    list.messages
      .filter((message) => message.To.some((to) => to.Address === address))
      .map((message) => message.ID),
  )
}
export async function nextMail(address: string, seen: Set<string> = new Set()) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const list = MailList.parse(await (await fetch(`${mailpit}/api/v1/messages`)).json())
    const message = list.messages.find(
      (item) => !seen.has(item.ID) && item.To.some((to) => to.Address === address),
    )
    if (message) {
      seen.add(message.ID)
      const detail = z
        .object({ Text: z.string() })
        .parse(await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json())
      return { subject: message.Subject, text: detail.Text }
    }
    await delay(100)
  }
  throw new Error(`No email arrived for ${address}`)
}
export async function emailCode(address: string, seen?: Set<string>) {
  const mail = await nextMail(address, seen)
  const code = mail.text.match(/\b\d{6}\b/)?.[0]
  assert(code, `The email to ${address} carries a six-digit code`)
  return code
}

export const syntheticEmail = (label: string) => `${label}-${randomUUID()}@huddle.test`
export function totpNow(secret: string) {
  return new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 }).generate()
}
export type Identity = {
  email: string
  secret: string
  recovery: string[]
  user: Extract<AccessStage, { kind: 'ready' }>['user']
}
export async function enroll(
  client: Client,
  email: string,
  stage: AccessStage,
  name: string,
): Promise<Identity> {
  assert.equal(stage.kind, 'enroll', `${email} reaches authenticator enrollment`)
  assert(stage.kind === 'enroll')
  const secret = stage.secret
  let view = await client.act({
    kind: 'enrollment.verify',
    generation: stage.generation,
    code: totpNow(secret),
  })
  assert(view.stage.kind === 'save-recovery')
  const recovery = view.stage.codes
  await client.act({ kind: 'recovery.ack', batch: view.stage.batch })
  await client.act({ kind: 'passkey.skip' })
  view = await client.act({
    kind: 'profile.save',
    profile: { name, avatar: { kind: 'mascot', shape: 'circle', color: 'indigo' } },
  })
  assert(view.stage.kind === 'ready')
  return { email, secret, recovery, user: view.stage.user }
}
export async function onboard(
  client: Client,
  options: { code: string; serverName: string; email?: string; name?: string },
) {
  const email = options.email ?? syntheticEmail('admin')
  const seen = await mailIds(email)
  await client.act({
    kind: 'setup.start',
    code: options.code,
    serverName: options.serverName,
    email,
  })
  const view = await client.act({ kind: 'email.verify', code: await emailCode(email, seen) })
  return enroll(client, email, view.stage, options.name ?? 'Server admin')
}
export async function invite(admin: Client, email: string) {
  const { response, value } = await admin.call('/api/invitations', { email })
  assert.equal(response.status, 200, `invite ${email}: ${JSON.stringify(value)}`)
  return value
}
export async function sendCode(client: Client, email: string) {
  const { response, value } = await client.call('/api/access', { kind: 'email.send', email })
  if (response.status !== 429) {
    assert.equal(response.status, 200, JSON.stringify(value))
    return
  }
  const { retryAt } = AccessError.parse(value)
  await delay(Math.max(0, Date.parse(z.string().parse(retryAt)) - Date.now()) + 100)
  await client.act({ kind: 'email.send', email })
}
export async function join(client: Client, email: string, name: string) {
  const seen = await mailIds(email)
  await sendCode(client, email)
  const view = await client.act({ kind: 'email.verify', code: await emailCode(email, seen) })
  return enroll(client, email, view.stage, name)
}
export async function invited(admin: Client, client: Client, name: string) {
  const email = syntheticEmail('member')
  await invite(admin, email)
  return join(client, email, name)
}

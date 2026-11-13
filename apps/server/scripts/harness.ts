import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { AccessStage, parseInvite, ServerInvite, type AccessCommand } from '@huddle/contracts'

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

export async function runningLivekit() {
  const start = 'Start it with: docker compose --profile dev up -d livekit-dev'
  const secret = process.env.LIVEKIT_API_SECRET
  if (!secret)
    throw new Error(`LIVEKIT_API_SECRET is not set. Run pnpm setup:local first. ${start}`)
  const url = process.env.LIVEKIT_PUBLIC_URL ?? `ws://localhost:${process.env.LIVEKIT_PORT ?? 7880}`
  const http = url.replace(/^ws/, 'http')
  for (let attempt = 0; attempt < 20; attempt++) {
    const answered = await fetch(http).then(
      (response) => response.ok,
      () => false,
    )
    if (answered) return { key: process.env.LIVEKIT_API_KEY ?? 'huddle', secret, url, http }
    await delay(250)
  }
  throw new Error(`This suite needs LiveKit, and nothing answers at ${http}. ${start}`)
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
    NODE_ENV: 'test',
    DATABASE_URL: options.databaseUrl,
    PORT: String(options.port),
    WS_PORT: String(options.port + 1),
    SERVER_URL: origin,
    WS_PUBLIC_URL: `ws://localhost:${options.port + 1}`,
    TRUSTED_ORIGINS: '',
    KLIPY_APP_KEY: 'huddle-suite-klipy-key',
    KLIPY_CONTENT_FILTER: undefined,
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

export function tailscale(login: string): Record<string, string> {
  return {
    'tailscale-user-login': login,
    'tailscale-user-name': login.slice(0, login.indexOf('@')),
  }
}
export class Client {
  userId: string | null = null
  constructor(
    readonly origin: string,
    readonly login?: string,
  ) {}
  async call(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(new URL(path, this.origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: this.origin,
        'Content-Type': 'application/json',
        ...(this.login ? tailscale(this.login) : {}),
        ...(body !== undefined && this.userId ? { 'X-Huddle-User': this.userId } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    const value: unknown = await response.json().catch(() => null)
    return { response, value }
  }
  private learn(stage: AccessStage) {
    this.userId = stage.kind === 'ready' ? stage.user.id : null
    return stage
  }
  async stage() {
    const { response, value } = await this.call('/api/access')
    assert.equal(response.status, 200, `stage: ${JSON.stringify(value)}`)
    return this.learn(AccessStage.parse(value))
  }
  async act(command: AccessCommand) {
    const { response, value } = await this.call('/api/access', command)
    assert.equal(response.status, 200, `${command.kind}: ${JSON.stringify(value)}`)
    return this.learn(AccessStage.parse(value))
  }
}

function readyUser(stage: AccessStage) {
  assert(stage.kind === 'ready', `expected ready, got ${stage.kind}`)
  return stage.user
}
export async function setupFriend(
  client: Client,
  options: { code: string; serverName: string; name: string },
) {
  return readyUser(await client.act({ kind: 'account.setup', ...options }))
}
export async function joinFriend(client: Client, code: string, name: string) {
  return readyUser(await client.act({ kind: 'account.join', code, name }))
}
export async function storedJoinCode(databaseUrl: string) {
  const sql = new pg.Client({ connectionString: databaseUrl })
  await sql.connect()
  try {
    return z.string().parse((await sql.query('SELECT code FROM join_code')).rows[0]?.code)
  } finally {
    await sql.end()
  }
}
export async function inviteCode(admin: Client) {
  const { response, value } = await admin.call('/api/invite')
  assert.equal(response.status, 200, `invite: ${JSON.stringify(value)}`)
  return parseInvite(ServerInvite.parse(value).invite).code
}
export async function accountLink(databaseUrl: string, ...args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/account-link.ts', ...args], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, TRUSTED_ORIGINS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const [code] = await once(child, 'exit')
  return { code: z.number().parse(code), stdout, stderr }
}

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { AccessView, FriendInvites, parseInvite, type AccessCommand } from '@huddle/contracts'

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
    NODE_ENV: 'test',
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

export class Client {
  cookies = new Map<string, string>()
  token = ''
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
        ...(this.native ? { 'X-Huddle-Client': 'native' } : {}),
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
    if (view.success) this.token = view.data.bearerToken ?? this.token
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

const mascot = { kind: 'mascot' as const, shape: 'circle' as const, color: 'indigo' as const }
async function nameFriend(client: Client, name: string) {
  const named = await client.act({
    kind: 'profile.save',
    profile: { name, avatar: mascot },
  })
  assert.equal(named.stage.kind, 'ready')
  assert(named.stage.kind === 'ready')
  return named.stage.user
}
export async function setupFriend(
  client: Client,
  options: { code: string; serverName: string; username: string; password: string; name: string },
) {
  const ready = await client.act({
    kind: 'account.setup',
    code: options.code,
    serverName: options.serverName,
    username: options.username,
    password: options.password,
  })
  assert.equal(ready.stage.kind, 'ready')
  return nameFriend(client, options.name)
}
export async function joinFriend(
  client: Client,
  code: string,
  username: string,
  password: string,
  name: string,
) {
  const ready = await client.act({ kind: 'account.join', code, username, password })
  assert.equal(ready.stage.kind, 'ready')
  return nameFriend(client, name)
}
export async function storedJoinCode(databaseUrl: string) {
  const { open } = await import('../src/lib/access-store')
  const sql = new pg.Client({ connectionString: databaseUrl })
  await sql.connect()
  try {
    const row = await sql.query('SELECT sealed_code FROM join_code')
    return await open(z.string().parse(row.rows[0]?.sealed_code), z.string())
  } finally {
    await sql.end()
  }
}
export async function friendCode(admin: Client) {
  const { response, value } = await admin.call('/api/friend-invite')
  assert.equal(response.status, 200, `friend invite: ${JSON.stringify(value)}`)
  const line = FriendInvites.parse(value).invites[0]
  assert.ok(line, 'the host has an invite line')
  return parseInvite(line).code
}

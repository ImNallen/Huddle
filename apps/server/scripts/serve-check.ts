import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { AccessStage, Channel, EventPage, Room, serverOrigin, VoiceGrant } from '@huddle/contracts'
import { migratedDatabase, startServer } from './harness'

const usage =
  'Usage: pnpm --filter @huddle/server test:serve https://<node>.<tailnet>.ts.net[:port]\nRun it on a tailnet machine, from a device signed in as a person, with LiveKit running as docs/hosting.md describes and the LIVEKIT_API_SECRET from .env. It starts a scratch server on 3790 and 3791, and does not change Serve for you. The port cannot be 8443, because LiveKit is published there.\n'
const target = process.argv[2]
if (!target) {
  process.stderr.write(usage)
  process.exit(2)
}
const address = serverOrigin(target)
assert.ok(address.startsWith('https:'), 'Serve publishes HTTPS, so use its https:// address.')
const url = new URL(address)
assert.ok(process.env.LIVEKIT_API_SECRET, 'LIVEKIT_API_SECRET is not set. Run pnpm setup:local.')
const livekitPort = Number(process.env.LIVEKIT_PORT ?? 7880)
const livekitPublic = new URL(process.env.LIVEKIT_PUBLIC_URL ?? `wss://${url.hostname}:8443`)
const livekitAddress = `https://${livekitPublic.host}`
assert.notEqual(
  url.port || '443',
  livekitPublic.port || '443',
  `LiveKit is published on ${livekitPublic.host}, so use another port for Huddle.`,
)
const port = Number(process.env.TEST_PORT ?? 3790)
const setupCode = `serve-${randomUUID()}`
const database = await migratedDatabase()
const server = await startServer({
  databaseUrl: database.url,
  port,
  env: {
    SERVER_URL: address,
    WS_PUBLIC_URL: `wss://${url.host}/events`,
    LIVEKIT_PUBLIC_URL: `wss://${livekitPublic.host}`,
    SETUP_CODE: setupCode,
  },
})
async function cleanUp() {
  await server.stop()
  await database.drop()
}
process.once('SIGINT', () => void cleanUp().finally(() => process.exit(130)))
const pass = (message: string) => process.stdout.write(`PASS ${message}\n`)
const stageAt = async (headers: Record<string, string> = {}, at = address) => {
  const response = await fetch(`${at}/api/access`, { headers })
  return AccessStage.parse(await response.json())
}
try {
  const https = url.port || '443'
  process.stdout.write(
    `\nIn another shell on this machine, run:\n\n  tailscale serve --bg --https=${https} http://127.0.0.1:${port}\n  tailscale serve --bg --https=${https} --set-path=/events http://127.0.0.1:${port + 1}\n  tailscale serve --bg --https=${livekitPublic.port || '443'} http://127.0.0.1:${livekitPort}\n\nWaiting for ${address} and ${livekitAddress}. Remove the Huddle mounts afterwards with: tailscale serve --https=${https} off\nLeave ${livekitPublic.port || '443'} in place if this machine hosts voice. Otherwise remove it with: tailscale serve --https=${livekitPublic.port || '443'} off\n\n`,
  )
  let served = false
  for (let attempt = 0; attempt < 240 && !served; attempt++) {
    served = await fetch(`${address}/api/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (!served) await delay(1000)
  }
  assert.ok(served, `${address} did not answer. Check tailscale serve status.`)
  pass('Serve answers over TLS that verifies with no extra trust')

  const stage = await stageAt()
  assert.notEqual(stage.kind, 'no-identity', `Serve attested nobody: ${JSON.stringify(stage)}`)
  assert.equal(stage.kind, 'setup')
  const login = stage.kind === 'setup' ? stage.login : ''
  pass(`Serve attests ${login}, and it keeps Host, because the Host gate let it through`)

  assert.deepEqual(await stageAt({ 'Tailscale-User-Login': 'evil@example.com' }), stage)
  pass('a client-sent identity header is replaced')
  assert.deepEqual(await stageAt({ Tailscale_User_Login: 'evil@example.com' }), stage)
  pass('a client-sent underscore header is ignored')
  assert.deepEqual(
    await stageAt({}, `http://localhost:${port}`),
    { kind: 'no-identity', reason: 'direct' },
    'a loopback caller without headers',
  )
  assert.deepEqual(
    await stageAt({ 'Tailscale-User-Login': 'evil@example.com' }, `http://localhost:${port}`),
    { kind: 'no-identity', reason: 'direct' },
    'loopback fails the Host gate because it is not the served address',
  )
  pass('a direct loopback caller has no identity')

  const node = z
    .object({ TUN: z.boolean(), Self: z.object({ TailscaleIPs: z.array(z.string()) }) })
    .parse(
      JSON.parse(
        execFileSync('tailscale', ['status', '--self', '--peers=false', '--json'], {
          encoding: 'utf8',
        }),
      ),
    )
  assert.equal(node.TUN, true, 'userspace mode forwards peers onto loopback, past Serve')
  const nodeAddress = node.Self.TailscaleIPs.find((ip) => ip.includes('.'))
  assert.ok(nodeAddress, 'this node has a Tailscale IPv4 address')
  for (const backend of [port, port + 1, livekitPort])
    await assert.rejects(
      fetch(`http://${nodeAddress}:${backend}/api/health`, { signal: AbortSignal.timeout(3000) }),
      `backend port ${backend} must be closed on the Tailscale address`,
    )
  pass(
    "Tailscale uses a TUN device, and the backend and LiveKit ports are closed on this node's Tailscale address",
  )

  const headers = { Origin: address, 'Content-Type': 'application/json' }
  const created = await fetch(`${address}/api/access`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'account.setup',
      code: setupCode,
      serverName: 'Serve check',
      name: 'Check',
    }),
  })
  const ready = AccessStage.parse(await created.json())
  assert.equal(ready.kind, 'ready')
  const socket = new WebSocket(`wss://${url.host}/events`, { origin: address })
  await once(socket, 'open')
  socket.send(JSON.stringify({ kind: 'watch', after: '0' }))
  const [frame] = await once(socket, 'message')
  EventPage.parse(JSON.parse(String(frame)))
  socket.terminate()
  pass('a WebSocket through /events reaches the listener at /, and Serve attests the upgrade')

  const userId = ready.kind === 'ready' ? ready.user.id : ''
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${address}${path}`, {
      method: 'POST',
      headers: { ...headers, 'X-Huddle-User': userId },
      body: JSON.stringify(body),
    })
    const value: unknown = await response.json()
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`)
    return value
  }
  const room = Room.parse(await post('/api/rooms', { name: 'Serve check' }))
  const channel = Channel.parse(
    await post('/api/channels', { roomId: room.id, name: 'voice', kind: 'voice' }),
  )
  const grant = VoiceGrant.parse(await post('/api/voice/token', { channelId: channel.id }))
  assert.equal(grant.url, `wss://${livekitPublic.host}`)
  let published = false
  for (let attempt = 0; attempt < 240 && !published; attempt++) {
    published = await fetch(livekitAddress).then(
      (response) => response.ok,
      () => false,
    )
    if (!published) await delay(1000)
  }
  assert.ok(
    published,
    `${livekitAddress} did not answer. Check LiveKit and tailscale serve status.`,
  )
  const validated = await fetch(
    `${livekitAddress}/rtc/validate?access_token=${encodeURIComponent(grant.token)}`,
  )
  assert.equal(validated.status, 200, `LiveKit: ${await validated.text()}`)
  const signalling = new WebSocket(`${grant.url}/rtc?access_token=${grant.token}`)
  await once(signalling, 'open')
  signalling.terminate()
  pass(`LiveKit answers over wss on ${livekitPublic.host} and accepts this server's token`)
  process.stdout.write('\nEvery observed Serve behaviour still holds.\n')
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  await cleanUp()
}

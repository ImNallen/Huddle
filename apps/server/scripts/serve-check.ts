import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { AccessStage, EventPage, serverOrigin } from '@huddle/contracts'
import { migratedDatabase, startServer } from './harness'

const usage =
  'Usage: pnpm --filter @huddle/server test:serve https://<node>.<tailnet>.ts.net[:port]\nRun it on a tailnet machine, from a device signed in as a person. It starts a scratch server on 3790 and 3791, and does not change Serve for you.\n'
const target = process.argv[2]
if (!target) {
  process.stderr.write(usage)
  process.exit(2)
}
const address = serverOrigin(target)
assert.ok(address.startsWith('https:'), 'Serve publishes HTTPS, so use its https:// address.')
const url = new URL(address)
const port = Number(process.env.TEST_PORT ?? 3790)
const setupCode = `serve-${randomUUID()}`
const database = await migratedDatabase()
const server = await startServer({
  databaseUrl: database.url,
  port,
  env: {
    SERVER_URL: address,
    WS_PUBLIC_URL: `wss://${url.host}/events`,
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
    `\nIn another shell on this machine, run:\n\n  tailscale serve --bg --https=${https} http://127.0.0.1:${port}\n  tailscale serve --bg --https=${https} --set-path=/events http://127.0.0.1:${port + 1}\n\nWaiting for ${address}. Remove these mounts afterwards with: tailscale serve --https=${https} off\n\n`,
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
  for (const backend of [port, port + 1])
    await assert.rejects(
      fetch(`http://${nodeAddress}:${backend}/api/health`, { signal: AbortSignal.timeout(3000) }),
      `backend port ${backend} must be closed on the Tailscale address`,
    )
  pass(
    "Tailscale uses a TUN device, and the backend ports are closed on this node's Tailscale address",
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
  process.stdout.write('\nEvery observed Serve behaviour still holds.\n')
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  await cleanUp()
}

import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { parseArgs } from 'node:util'

const claimPort = (port) =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const claimed = server.address().port
      server.close(() => resolve(claimed))
    })
  })

const claimUdpPort = (port) =>
  new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    socket.once('error', reject)
    socket.bind(port, '127.0.0.1', () => {
      const claimed = socket.address().port
      socket.close(() => resolve(claimed))
    })
  })

const livekitLines = async (local, present) => {
  const wanted = {
    LIVEKIT_API_SECRET: async () => randomBytes(32).toString('hex'),
    ...(local && {
      LIVEKIT_PORT: () => claimPort(7880).catch(() => claimPort(0)),
      LIVEKIT_UDP_PORT: () => claimUdpPort(7882).catch(() => claimUdpPort(0)),
    }),
  }
  const lines = []
  for (const [name, value] of Object.entries(wanted))
    if (!present(name)) lines.push(`${name}=${await value()}\n`)
  return lines
}

const { values } = parseArgs({ options: { 'server-url': { type: 'string' } } })
const envFile = new URL('../.env', import.meta.url)
const existing = await readFile(envFile, 'utf8').catch((error) => {
  if (error.code !== 'ENOENT') throw error
  return null
})

if (existing === null) {
  const password = randomBytes(24).toString('hex')
  const port = await claimPort(5434).catch(() => claimPort(0))
  const database = `DATABASE_URL=postgresql://huddle:${password}@localhost:${port}/huddle\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_PORT=${port}\n`
  const app = values['server-url']
    ? `SERVER_URL=${values['server-url']}\n`
    : `SERVER_URL=http://localhost:3000\nPORT=3002\nWS_PORT=3003\nWS_PUBLIC_URL=ws://localhost:3000/events\nHUDDLE_DEV_LOGIN=you@huddle.local\nTRUSTED_ORIGINS=http://localhost:1420,http://127.0.0.1:1420\n`
  const livekit = await livekitLines(!values['server-url'], () => false)
  await writeFile(envFile, database + app + livekit.join(''), { flag: 'wx', mode: 0o600 })
  process.stdout.write(
    'Created .env with a generated database password and LiveKit secret. Run docker compose up -d db.\n',
  )
} else {
  const local = !/^SERVER_URL=https:/m.test(existing)
  const added = await livekitLines(local, (name) => new RegExp(`^${name}=`, 'm').test(existing))
  if (added.length) {
    const separator = existing.endsWith('\n') || !existing ? '' : '\n'
    await appendFile(envFile, separator + added.join(''))
    process.stdout.write(
      `.env already exists. Added ${added.map((line) => line.slice(0, line.indexOf('='))).join(', ')} and changed nothing else.\n`,
    )
  } else process.stdout.write('.env already exists. Kept your configuration.\n')
}

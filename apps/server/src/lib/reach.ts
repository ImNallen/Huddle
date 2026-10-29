import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import dgram from 'node:dgram'
import os from 'node:os'
import { promisify } from 'node:util'
import { z } from 'zod'
import { config } from './config'

const execFileAsync = promisify(execFile)

export type FriendReach = {
  pin: string
  port: number
  lan: string[]
  external?: { address: string; port: number }
}

const ReachFile = z.object({
  pin: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  port: z.number().int(),
  lan: z.array(z.string()),
  external: z.object({ address: z.string(), port: z.number().int() }).optional(),
})

let current: FriendReach | undefined

function reachPath() {
  return `data/friend/${config.FRIEND_PORT}/reach.json`
}

export async function setFriendReach(value: FriendReach) {
  current = value
  await writeFile(reachPath(), `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

export async function friendReach() {
  if (current) return current
  try {
    current = ReachFile.parse(JSON.parse(await readFile(reachPath(), 'utf8')))
    return current
  } catch {
    return undefined
  }
}

export function lanAddresses() {
  const found = new Set<string>()
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      if (isShareable(entry.address)) found.add(entry.address)
    }
  }
  return [...found]
}

function isShareable(address: string) {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  const a = parts[0] ?? -1
  const b = parts[1] ?? -1
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true
  return a === 100 && b >= 64 && b <= 127
}

async function gateway() {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('route', ['-n', 'get', 'default'])
      return /gateway: (\d+\.\d+\.\d+\.\d+)/.exec(stdout)?.[1]
    }
    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('ip', ['route', 'show', 'default'])
      return /default via (\d+\.\d+\.\d+\.\d+)/.exec(stdout)?.[1]
    }
  } catch {
    return undefined
  }
  return undefined
}

function ask(socket: dgram.Socket, host: string, packet: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timeout'))
    }, 700)
    const onMessage = (message: Buffer) => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
    socket.send(packet, 5351, host, (error) => {
      if (!error) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      reject(error)
    })
  })
}

export function renewDelay(lifetime: number) {
  if (!Number.isFinite(lifetime) || lifetime < 1) return 60
  const half = Math.floor(lifetime / 2)
  return Math.min(86400, Math.max(1, half))
}

export async function mapPort(internalPort: number) {
  const host = await gateway()
  if (!host) return
  const socket = dgram.createSocket('udp4')
  socket.on('error', () => undefined)
  try {
    const address = await ask(socket, host, Buffer.from([0, 0, 0, 0]))
    if (address.length < 12 || address[0] !== 0 || address[1] !== 128 || address.readUInt16BE(2) !== 0)
      return
    const externalAddress = `${address[8]}.${address[9]}.${address[10]}.${address[11]}`
    if (externalAddress === '0.0.0.0') return
    const request = Buffer.alloc(12)
    request[1] = 2
    request.writeUInt16BE(internalPort, 4)
    request.writeUInt16BE(internalPort, 6)
    request.writeUInt32BE(3600, 8)
    const mapped = await ask(socket, host, request)
    if (mapped.length < 16 || mapped[1] !== 130 || mapped.readUInt16BE(2) !== 0) return
    const externalPort = mapped.readUInt16BE(10)
    const lifetime = mapped.readUInt32BE(12)
    if (!externalPort || !lifetime) return
    return { address: externalAddress, port: externalPort, lifetime }
  } catch {
    return undefined
  } finally {
    socket.close()
  }
}

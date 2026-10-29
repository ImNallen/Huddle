import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const sequence = (body: Buffer) => der(0x30, body)
const integer = (body: Buffer) => {
  let value = body
  while (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) value = value.subarray(1)
  if (value[0]! & 0x80) value = Buffer.concat([Buffer.from([0]), value])
  return der(0x02, value)
}
function der(tag: number, body: Buffer) {
  const length =
    body.length < 128
      ? Buffer.from([body.length])
      : body.length < 256
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff])
  return Buffer.concat([Buffer.from([tag]), length, body])
}
const oid = (bytes: number[]) => der(0x06, Buffer.from(bytes))
const bitString = (body: Buffer) => der(0x03, Buffer.concat([Buffer.from([0x00]), body]))
const utc = (date: Date) => {
  const pad = (value: number) => value.toString().padStart(2, '0')
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return der(0x17, Buffer.from(text))
}
function distinguishedName(commonName: string) {
  const attribute = sequence(
    Buffer.concat([oid([0x55, 0x04, 0x03]), der(0x0c, Buffer.from(commonName))]),
  )
  return sequence(der(0x31, attribute))
}
const algorithm = sequence(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))
function certificate(publicKey: KeyObject, privateKey: KeyObject) {
  const now = Date.now()
  const exported = publicKey.export({ type: 'spki', format: 'der' })
  const spki = Buffer.isBuffer(exported) ? exported : Buffer.from(exported)
  const subject = distinguishedName('huddle')
  const tbs = sequence(
    Buffer.concat([
      der(0xa0, integer(Buffer.from([0x02]))),
      integer(randomBytes(16)),
      algorithm,
      subject,
      sequence(
        Buffer.concat([
          utc(new Date(now - 5 * 60 * 1000)),
          utc(new Date(now + 5 * 365 * 24 * 60 * 60 * 1000)),
        ]),
      ),
      subject,
      spki,
    ]),
  )
  const signature = sign('sha256', tbs, privateKey)
  const cert = sequence(Buffer.concat([tbs, algorithm, bitString(signature)]))
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return {
    cert,
    key: typeof pem === 'string' ? pem : pem.toString(),
    certificate: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----\n`,
  }
}
export function pinCertificate(raw: Buffer) {
  return createHash('sha256').update(raw).digest('base64url')
}
export async function loadIdentity(directory: string) {
  await mkdir(directory, { recursive: true })
  const certPath = `${directory}/cert.pem`
  const keyPath = `${directory}/key.pem`
  try {
    const [certificate, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')])
    const raw = Buffer.from(certificate.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64')
    return { certificate, key, pin: pinCertificate(raw) }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const created = certificate(pair.publicKey, pair.privateKey)
  await mkdir(dirname(certPath), { recursive: true })
  await writeFile(keyPath, created.key, { mode: 0o600 })
  await writeFile(certPath, created.certificate, { mode: 0o600 })
  return { certificate: created.certificate, key: created.key, pin: pinCertificate(created.cert) }
}

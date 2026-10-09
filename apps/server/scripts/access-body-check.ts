import assert from 'node:assert/strict'
import { request } from 'node:http'

const base = process.env.SERVER_URL ?? 'http://localhost:3000'
async function oversized(path: string, size: number) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      new URL(path, base),
      {
        method: 'POST',
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode ?? 0))
      },
    )
    req.once('error', reject)
    for (let sent = 0; sent < size; sent += 8192)
      req.write(Buffer.alloc(Math.min(8192, size - sent), 65))
    req.end()
  })
}
assert.equal(await oversized('/api/account/photo', 5 * 1024 * 1024 + 8193), 400)
assert.equal(await oversized('/api/access', 65537), 400)
process.stdout.write('PASS chunked photo and JSON bodies reject at the streaming size boundary.\n')

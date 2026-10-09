import { AccessFailure } from './access-store'

export async function boundedBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get('content-length')
  if (length && Number(length) > maximum) throw new AccessFailure('invalid')
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) {
        await reader.cancel()
        throw new AccessFailure('invalid')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

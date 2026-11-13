export class OutboundError extends Error {
  constructor(readonly reason: 'refused' | 'oversized' | 'timeout') {
    super(`The outside service request was ${reason}.`)
  }
}

async function readCapped(response: Response, limit: number) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new OutboundError('oversized')
    }
    text += decoder.decode(value, { stream: true })
  }
}

export async function fetchAnonymous(
  url: string,
  { limit, timeout, signal }: { limit: number; timeout: number; signal: AbortSignal },
) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (signal.aborted) stop()
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, timeout)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) throw new OutboundError('refused')
    return await readCapped(response, limit)
  } catch (cause) {
    if (controller.signal.aborted && !signal.aborted) throw new OutboundError('timeout')
    throw cause
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

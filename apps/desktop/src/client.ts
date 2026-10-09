import { isTauri, invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { z } from 'zod'
import { serverOrigin, ServerInfo, Session } from '@huddle/contracts'

export const native = isTauri()
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
export class Client {
  private lifetime = new AbortController()
  token: string | null = null
  get active() {
    return !this.lifetime.signal.aborted
  }
  disconnect() {
    this.lifetime.abort()
    this.token = null
  }
  readonly origin: string
  constructor(origin: string) {
    this.origin = serverOrigin(origin)
  }
  endpoint(path: string) {
    const proxy =
      !native &&
      ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
      this.origin === 'http://localhost:3000'
    return proxy ? path : this.origin + path
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    const response = await fetch(this.endpoint(path), {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      credentials: native ? 'omit' : 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
    })
    const value: unknown = await response.json()
    if (!response.ok) {
      const error = z
        .object({
          message: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        })
        .safeParse(value)
      throw new RequestError(
        response.status,
        error.success
          ? (error.data.message ??
            error.data.error ??
            error.data.error_description ??
            'The request failed.')
          : 'The request failed.',
      )
    }
    return schema.parse(value)
  }
  info() {
    return this.request('/api/info', ServerInfo)
  }
  session(signal?: AbortSignal) {
    return this.request('/api/auth/get-session', Session.nullable(), undefined, signal)
  }
  async restore() {
    if (native) {
      const token = await invoke<string | null>('load_token', { origin: this.origin })
      if (this.active) this.token = token
    }
  }
  async remember(token: string, signal?: AbortSignal) {
    if (!this.active || signal?.aborted) return
    if (native) {
      await invoke('save_token', { origin: this.origin, token })
      if (!this.active || signal?.aborted) {
        await this.forget()
        return
      }
      this.token = token
    }
  }
  async forget() {
    this.token = null
    if (native) await invoke('clear_token', { origin: this.origin })
  }
  async signOut() {
    try {
      await this.request('/api/auth/sign-out', z.unknown(), {})
    } finally {
      await this.forget()
    }
  }
}
export async function openBrowser(url: string) {
  if (native) await openUrl(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

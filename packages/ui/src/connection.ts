import { z } from 'zod'
import {
  AccessCommand,
  AccessError,
  AccessStage,
  PhotoUpload,
  ServerInfo,
  serverOrigin,
  type UserId,
} from '@huddle/contracts'
import type { Transport } from './transport'

export type AccessErrorCode = AccessError['error']
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAt?: string,
    public code?: AccessErrorCode,
  ) {
    super(message)
  }
}
export class NetworkError extends Error {
  constructor(readonly host: string) {
    super(`Huddle couldn't reach ${host}.`)
  }
}
export class Connection implements Transport {
  protected lifetime = new AbortController()
  readonly origin: string
  private actingAs: UserId | null = null
  onAccessChanged: (() => void) | null = null
  constructor(origin: string) {
    this.origin = serverOrigin(origin)
  }
  get active() {
    return !this.lifetime.signal.aborted
  }
  disconnect() {
    this.lifetime.abort()
    this.actingAs = null
  }
  endpoint(path: string) {
    return this.origin + path
  }
  private headers(post: boolean, json = true) {
    const headers = new Headers()
    if (json) headers.set('Content-Type', 'application/json')
    if (post && this.actingAs) headers.set('X-Huddle-User', this.actingAs)
    return headers
  }
  private signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
  }
  private async send(path: string, init: RequestInit) {
    const response = await fetch(this.endpoint(path), init).catch((failure: unknown) => {
      if (failure instanceof TypeError) throw new NetworkError(new URL(this.origin).host)
      throw failure
    })
    if (response.status === 401) this.onAccessChanged?.()
    return response
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.send(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.signal(signal),
      cache: 'no-store',
    })
    const value: unknown = await response.json().catch(() => {
      throw new RequestError(
        response.status,
        'The server sent a response Huddle does not understand.',
      )
    })
    if (!response.ok) {
      const error = z
        .object({
          message: z.string().optional(),
          error: z.string().optional(),
          retryAt: z.string().optional(),
        })
        .safeParse(value)
      const code = AccessError.shape.error.safeParse(error.data?.error)
      throw new RequestError(
        response.status,
        error.success
          ? (error.data.message ?? errorMessage(error.data.error))
          : 'The request failed.',
        error.success ? error.data.retryAt : undefined,
        code.success ? code.data : undefined,
      )
    }
    return schema.parse(value)
  }
  info() {
    return this.request('/api/info', ServerInfo)
  }
  /** Later POSTs claim this stage's account. Call it only as the view for that stage mounts. */
  settle(stage: AccessStage) {
    this.actingAs = stage.kind === 'ready' ? stage.user.id : null
  }
  stage(signal?: AbortSignal) {
    return this.request('/api/access', AccessStage, undefined, signal)
  }
  async act(command: AccessCommand, signal?: AbortSignal) {
    const stage = await this.request(
      '/api/access',
      AccessStage,
      AccessCommand.parse(command),
      signal,
    )
    if (this.active && !signal?.aborted) this.settle(stage)
    return stage
  }
  async upload(file: File) {
    const body = new FormData()
    body.set('photo', file)
    const response = await this.send('/api/account/photo', {
      method: 'POST',
      headers: this.headers(true, false),
      body,
      signal: this.signal(),
    })
    if (!response.ok)
      throw new Error(
        'The photo could not be uploaded. Use a PNG, JPEG or WebP smaller than 5 MB and 4096 × 4096 pixels.',
      )
    const value: unknown = await response.json()
    return PhotoUpload.parse(value).uploadId
  }
  async photo(id: string, signal: AbortSignal) {
    const response = await this.send(`/api/account/photo/${encodeURIComponent(id)}`, {
      headers: this.headers(false, false),
      signal: this.signal(signal),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('The photo could not be loaded.')
    const blob = await response.blob()
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('Unable to display this photo.'))
      reader.onerror = () => reject(new Error('Unable to display this photo.'))
      reader.readAsDataURL(blob)
    })
  }
}
function errorMessage(error?: string) {
  switch (error) {
    case 'invalid':
      return 'That didn’t work. Check what you entered and try again.'
    case 'expired':
      return 'This step expired. Start again.'
    case 'rate_limited':
      return 'Too many attempts. Please wait before trying again.'
    case 'unavailable':
      return 'This service is currently unavailable. Please try again later.'
    case 'no_access':
      return 'Tailscale no longer says this is you. Check that it is connected.'
    default:
      return error ?? 'The request failed.'
  }
}

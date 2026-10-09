import { z } from 'zod'
import {
  AccessCommand,
  AccessView,
  PhotoUpload,
  ServerInfo,
  Session,
  serverOrigin,
  type AccessCommand as Command,
  type AccessView as View,
} from '@huddle/contracts'
import type { Transport } from './transport'

export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAt?: string,
  ) {
    super(message)
  }
}
export class Connection implements Transport {
  protected lifetime = new AbortController()
  private continuation: string | undefined
  token: string | null = null
  readonly origin: string
  constructor(
    origin: string,
    readonly native = false,
  ) {
    this.origin = serverOrigin(origin)
  }
  get active() {
    return !this.lifetime.signal.aborted
  }
  disconnect() {
    this.lifetime.abort()
    this.token = null
    this.continuation = undefined
  }
  endpoint(path: string) {
    return this.origin + path
  }
  protected headers(json = true) {
    const headers = new Headers()
    if (json) headers.set('Content-Type', 'application/json')
    if (this.native) headers.set('X-Huddle-Client', 'native')
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    if (this.continuation) headers.set('X-Huddle-Continuation', this.continuation)
    return headers
  }
  protected signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(this.endpoint(path), {
      method: body === undefined ? 'GET' : 'POST',
      headers: this.headers(),
      credentials: this.native ? 'omit' : 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.signal(signal),
      cache: 'no-store',
    })
    const value: unknown = await response.json()
    if (!response.ok) {
      const error = z
        .object({
          message: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
          retryAt: z.string().optional(),
        })
        .safeParse(value)
      throw new RequestError(
        response.status,
        error.success
          ? (error.data.message ?? error.data.error_description ?? errorMessage(error.data.error))
          : 'The request failed.',
        error.success ? error.data.retryAt : undefined,
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
  async resume(signal?: AbortSignal) {
    const view = await this.request('/api/access', AccessView, undefined, signal)
    this.receive(view, signal)
    return view
  }
  async act(command: Command, signal?: AbortSignal) {
    const view = await this.request('/api/access', AccessView, AccessCommand.parse(command), signal)
    this.receive(view, signal)
    return view
  }
  receive(view: View, signal?: AbortSignal) {
    if (!this.active || signal?.aborted) return
    if (view.continuation) this.continuation = view.continuation
    if (view.bearerToken) this.token = view.bearerToken
    if (view.stage.kind === 'signin') {
      this.continuation = undefined
      this.token = null
    }
    if (view.stage.kind === 'ready') this.continuation = undefined
  }
  async restore() {}
  async remember(token: string, signal?: AbortSignal) {
    if (this.active && !signal?.aborted) this.token = token
  }
  async forget() {
    this.token = null
    this.continuation = undefined
  }
  async signOut() {
    try {
      await this.act({ kind: 'signout' })
    } finally {
      await this.forget()
    }
  }
  async upload(file: File) {
    const body = new FormData()
    body.set('photo', file)
    const response = await fetch(this.endpoint('/api/account/photo'), {
      method: 'POST',
      headers: this.headers(false),
      credentials: this.native ? 'omit' : 'include',
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
    const response = await fetch(this.endpoint(`/api/account/photo/${encodeURIComponent(id)}`), {
      headers: this.headers(false),
      credentials: this.native ? 'omit' : 'include',
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
      return 'That code or action could not be verified. Please try again.'
    case 'expired':
      return 'This verification expired. Start again.'
    case 'rate_limited':
      return 'Too many attempts. Please wait before trying again.'
    case 'unavailable':
      return 'This service is currently unavailable. Please try again later.'
    case 'reauth_required':
      return 'Please verify your identity again to continue.'
    default:
      return error ?? 'The request failed.'
  }
}

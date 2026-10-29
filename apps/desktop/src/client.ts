import { isTauri, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Connection } from '@huddle/ui'
import { CredentialStore } from './credentials'
export { RequestError, errorText } from '@huddle/ui'

export const native = isTauri()
export class Client extends Connection {
  private readonly credentials: CredentialStore
  constructor(
    origin: string,
    private readonly transportOrigin?: string,
  ) {
    super(origin, native)
    this.credentials = new CredentialStore(this.origin, {
      load: (origin) => invoke<string | null>('load_token', { origin }),
      save: (origin, token) => invoke('save_token', { origin, token }),
      clear: (origin) => invoke('clear_token', { origin }),
    })
  }
  override endpoint(path: string) {
    if (this.transportOrigin) return `${this.transportOrigin.replace(/\/$/, '')}${path}`
    const proxy =
      !native &&
      ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
      this.origin === (import.meta.env.VITE_HUDDLE_DEV_SERVER ?? 'http://localhost:3000')
    return proxy ? path : super.endpoint(path)
  }
  override async info() {
    const info = await super.info()
    if (!this.transportOrigin) return info
    const local = new URL(this.transportOrigin)
    local.protocol = 'ws:'
    return { ...info, websocketUrl: local.origin }
  }
  override async restore() {
    if (native && !this.token) {
      const token = await this.credentials.restore(() => this.active)
      if (this.active && token) this.token = token
    }
  }
  override async remember(token: string, signal?: AbortSignal) {
    if (!this.active || signal?.aborted) return
    if (native && !(await this.credentials.remember(token, () => this.active && !signal?.aborted)))
      return
    if (this.active && !signal?.aborted) this.token = token
  }
  override async forget() {
    await super.forget()
    if (native) await this.credentials.forget()
  }
}
export async function openInvite(host: string, port: number, pin: string) {
  if (!native) throw new Error('Paste that invite in the Huddle app.')
  return invoke<string>('open_invite', { host, port, pin })
}
export async function openBrowser(url: string) {
  if (native) await openUrl(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}
export async function focusWindow() {
  if (native) await getCurrentWindow().setFocus()
}

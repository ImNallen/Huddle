import { isTauri } from '@tauri-apps/api/core'
import { Connection } from '@huddle/ui'

export const native = isTauri()
export class Client extends Connection {
  override endpoint(path: string) {
    const proxy =
      !native &&
      ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
      this.origin === (import.meta.env.VITE_HUDDLE_DEV_SERVER ?? 'http://localhost:3000')
    return proxy ? path : super.endpoint(path)
  }
}

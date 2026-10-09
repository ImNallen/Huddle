import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { z } from 'zod'
import { serverOrigin } from '@huddle/contracts'
import { Alert, Frame, Heading, Primary, serverInitials } from './primitives'
import { errorText } from './transport'

const SavedServer = z.object({ origin: z.string(), name: z.string() })
export type SavedServer = z.infer<typeof SavedServer>
const storageKey = 'huddle.servers'
export function readSavedServers(): SavedServer[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const saved = SavedServer.array().parse(JSON.parse(localStorage.getItem(storageKey) ?? '[]'))
    return saved.filter((item) => {
      try {
        return serverOrigin(item.origin) === item.origin
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}
export function saveServer(server: SavedServer) {
  const next = [
    server,
    ...readSavedServers().filter((item) => item.origin !== server.origin),
  ].slice(0, 12)
  localStorage.setItem(storageKey, JSON.stringify(next))
  localStorage.setItem('huddle.server', server.origin)
}
export function Connect({
  initialOrigin = '',
  connect,
  close,
}: {
  initialOrigin?: string
  connect: (origin: string) => Promise<void>
  close?: () => void
}) {
  const [servers, setServers] = useState<SavedServer[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setServers(readSavedServers()), [])
  async function choose(origin: string) {
    setBusy(true)
    setError('')
    try {
      await connect(serverOrigin(origin))
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const origin = z.string().parse(new FormData(event.currentTarget).get('server'))
    void choose(origin)
  }
  function remove(origin: string) {
    try {
      const next = servers.filter((item) => item.origin !== origin)
      localStorage.setItem(storageKey, JSON.stringify(next))
      setServers(next)
    } catch (failure) {
      setError(errorText(failure))
    }
  }
  return (
    <Frame>
      <Heading
        title="Connect to Huddle"
        description="Enter your company's Huddle server. It's in your invite email, or ask your IT team for the address."
        back={close}
      />
      <form onSubmit={submit}>
        <label className="access-label">
          Server address
          <input
            name="server"
            type="url"
            required
            defaultValue={initialOrigin}
            placeholder="https://chat.yourcompany.com"
            autoComplete="url"
          />
        </label>
        <Alert message={error} />
        <Primary busy={busy}>Connect</Primary>
      </form>
      {servers.length > 0 && (
        <div className="access-footer">
          <p>Saved servers</p>
          {servers.map((server) => (
            <div className="access-row" key={server.origin}>
              <button
                className="access-saved-server"
                disabled={busy}
                onClick={() => void choose(server.origin)}
              >
                <i className="access-server-tile">{serverInitials(server.name)}</i>
                <span>
                  {server.name}
                  <small>{new URL(server.origin).host}</small>
                </span>
                <ArrowRight size={14} />
              </button>
              <button
                className="access-link"
                aria-label={`Remove ${server.name} from saved servers`}
                onClick={() => remove(server.origin)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="access-footer">
        Huddle is hosted by your company. Your account, rooms and messages live on the server you
        connect to.
      </p>
    </Frame>
  )
}

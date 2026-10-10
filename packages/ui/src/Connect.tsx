import { useEffect, useState, type FormEvent } from 'react'
import { CircleAlert, RefreshCw, WifiOff, X } from 'lucide-react'
import { z } from 'zod'
import { serverOrigin } from '@huddle/contracts'
import { Alert, Frame, Heading, Primary, ServerTile, hostOf } from './primitives'
import { NetworkError } from './connection'
import { errorText } from './transport'

const SavedServer = z.object({
  origin: z.string(),
  name: z.string(),
  lastUsedAt: z.number().optional(),
})
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
export function saveServer(server: Omit<SavedServer, 'lastUsedAt'>) {
  const next = [
    { ...server, lastUsedAt: Date.now() },
    ...readSavedServers().filter((item) => item.origin !== server.origin),
  ].slice(0, 12)
  localStorage.setItem(storageKey, JSON.stringify(next))
  localStorage.setItem('huddle.server', server.origin)
}
type Problem =
  | { kind: 'address'; message: string }
  | { kind: 'unreachable'; host: string }
  | { kind: 'other'; message: string }
function parseAddress(input: string): { origin: string } | { problem: Problem } {
  const text = input.trim()
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return {
      problem: { kind: 'address', message: 'Enter an address like https://chat.yourcompany.com.' },
    }
  }
  try {
    return { origin: serverOrigin(withScheme) }
  } catch {
    const message =
      url.protocol === 'http:'
        ? 'Use an https:// address. Plain http only works for a server on localhost.'
        : url.protocol === 'https:'
          ? 'Use only the server address, without a path or sign-in details.'
          : 'Use an https:// address.'
    return { problem: { kind: 'address', message } }
  }
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
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const [now] = useState(() => Date.now())
  useEffect(() => setServers(readSavedServers()), [])
  async function choose(input: string) {
    const parsed = parseAddress(input)
    if ('problem' in parsed) return setProblem(parsed.problem)
    setBusy(true)
    setProblem(null)
    try {
      await connect(parsed.origin)
    } catch (failure) {
      setProblem(
        failure instanceof NetworkError
          ? { kind: 'unreachable', host: hostOf(parsed.origin) }
          : { kind: 'other', message: errorText(failure) },
      )
    } finally {
      setBusy(false)
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void choose(z.string().parse(new FormData(event.currentTarget).get('server')))
  }
  function remove(origin: string) {
    try {
      const next = servers.filter((item) => item.origin !== origin)
      localStorage.setItem(storageKey, JSON.stringify(next))
      setServers(next)
    } catch (failure) {
      setProblem({ kind: 'other', message: errorText(failure) })
    }
  }
  return (
    <Frame>
      <Heading
        title="Connect to Huddle"
        description="Enter your company's Huddle server. It's in your invite email, or ask your IT team for the address."
        back={close}
      />
      <form onSubmit={submit} noValidate>
        <label className="access-label">
          Server address
          <input
            className="access-mono"
            name="server"
            type="url"
            inputMode="url"
            required
            defaultValue={initialOrigin}
            placeholder="https://chat.yourcompany.com"
            autoComplete="url"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={
              problem?.kind === 'address' || problem?.kind === 'unreachable' || undefined
            }
            onChange={() => setProblem(null)}
          />
        </label>
        {problem?.kind === 'address' && (
          <p className="access-field-error" role="alert">
            <CircleAlert size={13} />
            {problem.message}
          </p>
        )}
        {problem?.kind === 'unreachable' && (
          <Alert
            icon={<WifiOff size={14} />}
            lead={`Can't reach ${problem.host}.`}
            message="Check the address for typos, then make sure you're on your company network or VPN."
          />
        )}
        {problem?.kind === 'other' && <Alert message={problem.message} />}
        <Primary busy={busy} busyLabel="Connecting…">
          {problem?.kind === 'unreachable' ? (
            <>
              <RefreshCw size={14} />
              Try again
            </>
          ) : (
            'Connect'
          )}
        </Primary>
      </form>
      {servers.length > 0 && (
        <div className="access-saved">
          <p>Saved servers</p>
          <ul>
            {servers.map((server) => (
              <li key={server.origin}>
                <button
                  type="button"
                  className="access-saved-server"
                  disabled={busy}
                  onClick={() => void choose(server.origin)}
                >
                  <ServerTile name={server.name} />
                  <span>
                    {server.name}
                    <small>{hostOf(server.origin)}</small>
                  </span>
                  {server.lastUsedAt && (
                    <time dateTime={new Date(server.lastUsedAt).toISOString()}>
                      {lastUsed(server.lastUsedAt, now)}
                    </time>
                  )}
                </button>
                <button
                  type="button"
                  className="access-saved-remove"
                  aria-label={`Remove ${server.name} from saved servers`}
                  onClick={() => remove(server.origin)}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="access-footer">
        Huddle is hosted by your company, so each team has its own server address. Your messages
        stay on that server.
      </p>
    </Frame>
  )
}
function lastUsed(at: number, now: number) {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (at >= startOfToday) return 'Today'
  const days = Math.ceil((startOfToday - at) / 86400000)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 35) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

import { useEffect, useState, type FormEvent } from 'react'
import { CircleAlert, RefreshCw, WifiOff, X } from 'lucide-react'
import { z } from 'zod'
import { inviteOrigin, parseInvite, serverOrigin, type FriendInvite } from '@huddle/contracts'
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
export function savedInvite(origin: string) {
  if (typeof localStorage === 'undefined') return
  const keyed = localStorage.getItem(`huddle.invite:${origin}`)
  if (keyed) return keyed
  const last = localStorage.getItem('huddle.invite')
  if (!last) return
  try {
    return inviteOrigin(parseInvite(last)) === origin ? last : undefined
  } catch {
    return
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
      problem: { kind: 'address', message: 'Paste the invite from your friend, or use http://localhost:3000 on the host.' },
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
  connectInvite,
  close,
}: {
  initialOrigin?: string
  connect: (origin: string) => Promise<void>
  connectInvite?: (invite: FriendInvite) => Promise<void>
  close?: () => void
}) {
  const [servers, setServers] = useState<SavedServer[]>([])
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const [now] = useState(() => Date.now())
  useEffect(() => setServers(readSavedServers()), [])
  async function choose(input: string) {
    const text = input.trim()
    if (text.startsWith('huddle:')) {
      let invite: FriendInvite
      try {
        invite = parseInvite(text)
      } catch (failure) {
        setProblem({
          kind: 'address',
          message: failure instanceof Error ? failure.message : 'That invite is incomplete. Ask for a new one.',
        })
        return
      }
      if (!connectInvite) {
        setProblem({ kind: 'address', message: 'Paste that invite in the Huddle app.' })
        return
      }
      const origin = inviteOrigin(invite)
      localStorage.setItem('huddle.invite', text)
      localStorage.setItem(`huddle.invite:${origin}`, text)
      localStorage.setItem(`huddle.join-code:${origin}`, invite.code)
      setBusy(true)
      setProblem(null)
      try {
        await connectInvite(invite)
      } catch (failure) {
        setProblem(
          failure instanceof NetworkError
            ? { kind: 'unreachable', host: invite.host }
            : { kind: 'other', message: errorText(failure) },
        )
      } finally {
        setBusy(false)
      }
      return
    }
    const parsed = parseAddress(text)
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
      localStorage.removeItem(`huddle.invite:${origin}`)
      const last = localStorage.getItem('huddle.invite')
      if (last) {
        try {
          if (inviteOrigin(parseInvite(last)) === origin) localStorage.removeItem('huddle.invite')
        } catch {
          localStorage.removeItem('huddle.invite')
        }
      }
      setServers(next)
    } catch (failure) {
      setProblem({ kind: 'other', message: errorText(failure) })
    }
  }
  return (
    <Frame>
      <Heading
        title="Connect to Huddle"
        description="Paste the invite from the friend who hosts Huddle. On the computer that hosts it, you can also use http://localhost:3000."
        back={close}
      />
      <form onSubmit={submit} noValidate>
        <label className="access-label">
          Invite or server address
          <input
            className="access-mono"
            name="server"
            type="text"
            required
            defaultValue={initialOrigin}
            placeholder="Paste an invite, or http://localhost:3000"
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
            message="Check the invite for typos, then make sure this computer can reach the friend who hosts Huddle."
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
                  onClick={() => void choose(savedInvite(server.origin) ?? server.origin)}
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
        One friend hosts the server. Everyone else pastes that friend's invite. Messages stay on
        that server.
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

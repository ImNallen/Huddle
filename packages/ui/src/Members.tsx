import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Users, X } from 'lucide-react'
import {
  Members,
  type Member,
  type MemberRole,
  type Server,
  type Me,
  type UserId,
} from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { Avatar } from './Avatar'

export type Resource<T> =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; value: T }
export const roleLabels: Record<MemberRole, string> = { admin: 'Admin', member: 'Member' }

function useResource<T>(client: Transport, path: string, schema: z.ZodType<T>, revision: unknown) {
  const [state, setState] = useState<Resource<T>>({ kind: 'loading' })
  useEffect(() => {
    const abort = new AbortController()
    setState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }))
    client.request(path, schema, undefined, abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setState({ kind: 'ready', value })
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setState({ kind: 'failed', message: errorText(error) })
      },
    )
    return () => abort.abort()
  }, [client, path, revision])
  return state
}
export function useMembers(client: Transport, revision: unknown): Resource<Member[]> {
  const state = useResource(client, '/api/members', Members, revision)
  return state.kind === 'ready' ? { kind: 'ready', value: state.value.members } : state
}
export function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
export function MemberToggle({
  pressed,
  onToggle,
  count,
}: {
  pressed: boolean
  onToggle: () => void
  count?: number
}) {
  return (
    <button
      className={`member-toggle ${count === undefined ? 'icon-button' : 'header-pill'}`}
      aria-label="Member list"
      title="Member list"
      aria-pressed={pressed}
      onClick={onToggle}
    >
      <Users size={count === undefined ? 20 : 16} />
      {count !== undefined && <span>Members · {count}</span>}
    </button>
  )
}
const groups: { role: MemberRole; title: string }[] = [
  { role: 'admin', title: 'Admins' },
  { role: 'member', title: 'Members' },
]
function MemberState({
  members,
  serverName,
  onRetry,
}: {
  members: Exclude<Resource<Member[]>, { kind: 'ready' }>
  serverName: string
  onRetry: () => void
}) {
  return members.kind === 'loading' ? (
    <div className="member-state" role="status">
      <h3>Loading people…</h3>
      <p>We’re loading the people on {serverName}.</p>
      <div className="member-skeleton" aria-hidden="true">
        <i />
        <i />
      </div>
    </div>
  ) : (
    <div className="member-state" role="alert">
      <h3>Couldn’t load friends</h3>
      <p>Check your connection, then try again.</p>
      <p>{members.message}</p>
      <button className="button small" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

export function MemberList({
  client,
  me,
  members,
  serverName,
  onSelect,
  onClose,
  onRetry,
}: {
  client: Transport
  me: Me
  members: Resource<Member[]>
  serverName: string
  onSelect: (member: Member, anchor: HTMLButtonElement) => void
  onClose: () => void
  onRetry: () => void
}) {
  const people = members.kind === 'ready' ? members.value : []
  return (
    <aside className="member-list" aria-label="Server members">
      <header className="member-list-header">
        <h2>Members{members.kind === 'ready' && ` · ${people.length}`}</h2>
        <button className="icon-button" aria-label="Close member list" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="member-list-scroll">
        {members.kind !== 'ready' ? (
          <MemberState members={members} serverName={serverName} onRetry={onRetry} />
        ) : (
          <ul className="member-groups" aria-label="Members">
            {groups.map(({ role, title }) => {
              const group = people.filter((member) => member.role === role)
              return (
                group.length > 0 && (
                  <li key={role}>
                    <h3>
                      {title} · {group.length}
                    </h3>
                    <ul>
                      {group.map((member) => {
                        const row = (
                          <>
                            <Avatar
                              avatar={member.avatar}
                              name={member.name}
                              photo={client.photo?.bind(client)}
                              size={28}
                            />
                            <span className="member-compact-name">
                              <span className="member-label">{member.name}</span>
                              {member.id === me.user.id && (
                                <span className="member-you"> · You</span>
                              )}
                            </span>
                          </>
                        )
                        return member.id === me.user.id ? (
                          <li key={member.id} className="member-row">
                            {row}
                          </li>
                        ) : (
                          <li key={member.id}>
                            <button
                              className="member-row"
                              aria-label={`View ${member.name}`}
                              aria-haspopup="dialog"
                              onClick={(event) => onSelect(member, event.currentTarget)}
                            >
                              {row}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                )
              )
            })}
          </ul>
        )}
      </div>
      <p className="member-list-note">Choose a person to message.</p>
    </aside>
  )
}

export function MemberDetails({
  client,
  member,
  serverName,
  anchor,
  onClose,
  onMessage,
}: {
  client: Transport
  member: Member
  serverName: string
  anchor: HTMLButtonElement
  onClose: () => void
  onMessage: (userId: UserId, signal?: AbortSignal) => Promise<void>
}) {
  const popover = useRef<HTMLDivElement>(null)
  const lifetime = useRef(new AbortController())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useLayoutEffect(() => {
    const panel = popover.current
    if (!panel) return
    const abort = new AbortController()
    lifetime.current = abort
    panel.showPopover()
    function place() {
      if (!panel || !anchor.getClientRects().length) return onClose()
      const row = anchor.getBoundingClientRect()
      const list = anchor.closest('.member-list')?.getBoundingClientRect() ?? row
      const box = panel.getBoundingClientRect()
      panel.style.left = `${Math.max(16, Math.min(list.left - box.width - 24, window.innerWidth - box.width - 16))}px`
      panel.style.top = `${Math.max(16, Math.min(row.top + 12, window.innerHeight - box.height - 16))}px`
    }
    place()
    panel.querySelector('button')?.focus({ preventScroll: true })
    const resize = new ResizeObserver(place)
    resize.observe(panel)
    resize.observe(anchor)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      abort.abort()
      resize.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      if (
        anchor.isConnected &&
        (panel.contains(document.activeElement) || document.activeElement === document.body)
      )
        anchor.focus({ preventScroll: true })
    }
  }, [anchor])
  async function message() {
    setBusy(true)
    setError('')
    try {
      await onMessage(member.id, lifetime.current.signal)
    } catch (failure) {
      if (!lifetime.current.signal.aborted) {
        setError(errorText(failure))
        setBusy(false)
      }
    }
  }
  return (
    <div
      ref={popover}
      popover="auto"
      role="dialog"
      className="member-details"
      aria-labelledby="member-details-name"
      onToggle={(event) => {
        if (event.newState === 'closed') onClose()
      }}
    >
      <header>
        <Avatar
          avatar={member.avatar}
          name={member.name}
          photo={client.photo?.bind(client)}
          size={56}
        />
        <button className="icon-button" aria-label="Close member details" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <h2 id="member-details-name">{member.name}</h2>
      <p className="member-details-role">{roleLabels[member.role]}</p>
      <p>
        Joined {serverName} on{' '}
        <time dateTime={member.joinedAt}>
          {new Date(member.joinedAt).toLocaleDateString([], { month: 'long', day: 'numeric' })}
        </time>
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="button primary"
        aria-label={`Message ${member.name}`}
        disabled={busy}
        onClick={() => void message()}
      >
        {busy ? 'Opening…' : 'Message'}
      </button>
    </div>
  )
}

export function MembersPage({
  client,
  me,
  server,
  members,
  onInvite,
  onMessage,
  onRetry,
}: {
  client: Transport
  me: Me
  server: Server
  members: Resource<Member[]>
  onInvite: () => void
  onMessage: (userId: UserId, signal?: AbortSignal) => Promise<void>
  onRetry: () => void
}) {
  const people = members.kind === 'ready' ? members.value : []
  const [sending, setSending] = useState<UserId | null>(null)
  const [error, setError] = useState('')
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    return () => abort.abort()
  }, [])
  async function message(userId: UserId) {
    setSending(userId)
    setError('')
    try {
      await onMessage(userId, lifetime.current.signal)
    } catch (failure) {
      if (!lifetime.current.signal.aborted) {
        setError(errorText(failure))
        setSending(null)
      }
    }
  }
  return (
    <main className="main">
      <header className="topbar members-topbar">
        <strong>Members</strong>
        <button className="header-pill topbar-action" onClick={onInvite}>
          Share invite
        </button>
      </header>
      <div className="scroll">
        <div className="members">
          <header className="members-introduction">
            <h1>People on {server.name}</h1>
            <p className="members-lede">
              {members.kind === 'ready'
                ? `${people.length} ${people.length === 1 ? 'person' : 'people'}. A little place to keep in touch.`
                : 'A little place to keep in touch.'}
            </p>
          </header>
          <section aria-label={`Members${members.kind === 'ready' ? ` · ${people.length}` : ''}`}>
            {members.kind !== 'ready' ? (
              <MemberState members={members} serverName={server.name} onRetry={onRetry} />
            ) : (
              <table className="members-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="role">Role</th>
                    <th className="joined">Joined</th>
                    <th className="member-action">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((member) => (
                    <tr key={member.id}>
                      <td>
                        <span className="member-name">
                          <Avatar
                            avatar={member.avatar}
                            name={member.name}
                            photo={client.photo?.bind(client)}
                            size={32}
                          />
                          <strong>
                            <span className="member-label">{member.name}</span>
                            {member.id === me.user.id && <span className="member-you"> · You</span>}
                          </strong>
                        </span>
                      </td>
                      <td className="role">{roleLabels[member.role]}</td>
                      <td className="joined">
                        <time dateTime={member.joinedAt}>{shortDate(member.joinedAt)}</time>
                      </td>
                      <td className="member-action">
                        {member.id !== me.user.id && (
                          <button
                            className="button small"
                            aria-label={`Message ${member.name}`}
                            disabled={sending !== null}
                            onClick={() => void message(member.id)}
                          >
                            {sending === member.id ? 'Opening…' : 'Message'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {members.kind === 'ready' && people.length === 1 && (
              <div className="member-state members-first">
                <h3>You’re the first one here</h3>
                <p>Friends appear after opening your invite and confirming their name.</p>
              </div>
            )}
          </section>
          <footer className="members-information">
            <p>Invited people, with access through Tailscale.</p>
            <p>Access is managed in Tailscale. Huddle can’t remove a member yet.</p>
          </footer>
        </div>
      </div>
    </main>
  )
}

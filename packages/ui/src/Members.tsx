import { useEffect, useState } from 'react'
import { z } from 'zod'
import { UserPlus, Users } from 'lucide-react'
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
export function MemberList({
  client,
  me,
  members,
  onMessage,
}: {
  client: Transport
  me: Me
  members: Resource<Member[]>
  onMessage: (userId: UserId) => Promise<void>
}) {
  const people = members.kind === 'ready' ? members.value : []
  const [error, setError] = useState('')
  return (
    <aside className="member-list">
      {members.kind === 'failed' ? (
        <p className="sidebar-note">Could not load friends.</p>
      ) : (
        <ul aria-label="Members">
          {groups.map(({ role, title }) => {
            const group = people.filter((member) => member.role === role)
            return (
              group.length > 0 && (
                <li key={role}>
                  <h2>
                    {title} — {group.length}
                  </h2>
                  <ul>
                    {group.map((member) => {
                      const row = (
                        <>
                          <Avatar
                            avatar={member.avatar}
                            name={member.name}
                            photo={client.photo?.bind(client)}
                            size={32}
                          />
                          <span>{member.name}</span>
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
                            aria-label={`Message ${member.name}`}
                            title={`Message ${member.name}`}
                            onClick={() => {
                              setError('')
                              onMessage(member.id).catch((failure: unknown) =>
                                setError(errorText(failure)),
                              )
                            }}
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
      {error && (
        <p className="sidebar-note form-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  )
}
export function MembersPage({
  client,
  me,
  server,
  members,
  onInvite,
}: {
  client: Transport
  me: Me
  server: Server
  members: Resource<Member[]>
  onInvite: () => void
}) {
  const people = members.kind === 'ready' ? members.value : []
  return (
    <main className="main">
      <header className="topbar">
        <Users size={20} />
        <strong>Members</strong>
        <button className="button small primary topbar-action" onClick={onInvite}>
          <UserPlus size={16} />
          Share invite
        </button>
      </header>
      <div className="scroll">
        <div className="members">
          <h1>People on {server.name}</h1>
          <p className="members-lede">
            Only people with an invite and access to this machine in Tailscale can create an account
            on this server. Huddle can't remove a member yet, so cut access in Tailscale.
          </p>
          <section aria-labelledby="members-title">
            <h2 id="members-title" className="members-heading">
              Members <span>{people.length}</span>
            </h2>
            {members.kind === 'failed' ? (
              <p className="form-error" role="alert">
                {members.message}
              </p>
            ) : (
              <div className="card members-card">
                <table className="members-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th className="role">Role</th>
                      <th className="joined">Joined</th>
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
                            <span>
                              <strong>
                                <span className="member-label">{member.name}</span>
                                {member.id === me.user.id && (
                                  <span className="member-you"> (you)</span>
                                )}
                              </strong>
                            </span>
                          </span>
                        </td>
                        <td className="role">
                          <span className={`tag ${member.role === 'admin' ? 'accent' : ''}`}>
                            {roleLabels[member.role]}
                          </span>
                        </td>
                        <td className="joined">{shortDate(member.joinedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {members.kind === 'ready' && people.length === 1 && (
              <p className="members-footnote">
                You’re the only member so far. People appear here after they open the invite link
                and confirm their name.
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}

import { useEffect, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { UserPlus } from 'lucide-react'
import { Members, type Member, type MemberRole, type Server, type Session } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { Avatar } from './Avatar'
import { visibleAccount } from './primitives'

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
export function MembersPage({
  client,
  session,
  server,
  members,
  onInvite,
}: {
  client: Transport
  session: Session
  server: Server
  members: Resource<Member[]>
  revision: number
  onInvite: () => void
  onChange: () => void
}) {
  const people = members.kind === 'ready' ? members.value : []
  const admin = people.some((member) => member.id === session.user.id && member.role === 'admin')
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function savePassword(event: FormEvent<HTMLFormElement>, userId: string) {
    event.preventDefault()
    const password = String(new FormData(event.currentTarget).get('password') ?? '')
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await client.request('/api/members/password', z.object({}).strict(), { userId, password })
      setNotice(
        userId === session.user.id
          ? 'Password updated. Sign in with the new one.'
          : 'Password updated. They can sign in with the new one.',
      )
      setResetFor(null)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="main">
      <header className="topbar">
        <strong>Members</strong>
        <button className="button primary topbar-action" onClick={onInvite}>
          <UserPlus size={15} />
          Share invite
        </button>
      </header>
      <div className="scroll">
        <div className="members">
          <h1>People on {server.name}</h1>
          <p className="members-lede">
            Only people with an invite can create an account on this server.
          </p>
          <section aria-labelledby="members-title">
            <h2 id="members-title" className="members-heading">
              Members <span>{people.length}</span>
            </h2>
            {notice && (
              <p className="members-notice" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {members.kind === 'failed' ? (
              <p className="form-error" role="alert">
                {members.message}
              </p>
            ) : (
              <table className="card members-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="role">Role</th>
                    <th className="joined">Joined</th>
                    {admin && <th className="actions">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {people.map((member) => {
                    const email = visibleAccount(member.email)
                    return (
                      <tr key={member.id}>
                        <td>
                          <span className="member-name">
                            <Avatar
                              avatar={member.avatar}
                              name={member.name}
                              photo={client.photo?.bind(client)}
                              size={24}
                            />
                            <span>
                              <strong>
                                {member.name}
                                {member.id === session.user.id && <span> (you)</span>}
                              </strong>
                              {email && <small>{email}</small>}
                            </span>
                          </span>
                        </td>
                        <td className="role">
                          <span className={`tag ${member.role === 'admin' ? 'accent' : ''}`}>
                            {roleLabels[member.role]}
                          </span>
                        </td>
                        <td className="joined">{shortDate(member.joinedAt)}</td>
                        {admin && (
                          <td className="actions">
                            {resetFor === member.id ? (
                              <form
                                className="members-reset"
                                onSubmit={(event) => void savePassword(event, member.id)}
                              >
                                <input
                                  name="password"
                                  type="password"
                                  required
                                  minLength={8}
                                  maxLength={200}
                                  autoComplete="new-password"
                                  aria-label={`New password for ${member.name}`}
                                />
                                <button className="button small primary" disabled={busy}>
                                  Save password
                                </button>
                                <button
                                  type="button"
                                  className="button small"
                                  disabled={busy}
                                  onClick={() => setResetFor(null)}
                                >
                                  Cancel
                                </button>
                              </form>
                            ) : (
                              <button
                                type="button"
                                className="button small"
                                onClick={() => {
                                  setResetFor(member.id)
                                  setError('')
                                  setNotice('')
                                }}
                              >
                                Reset password
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {members.kind === 'ready' && people.length === 1 && (
              <p className="members-footnote">
                You’re the only member so far. People appear here after they paste the invite and
                create a username.
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}

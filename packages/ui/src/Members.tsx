import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Mail, UserPlus } from 'lucide-react'
import {
  Invitation,
  Members,
  PendingInvitations,
  type Member,
  type MemberRole,
  type PendingInvitation,
  type Server,
  type Session,
} from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { Avatar } from './Avatar'

export type Resource<T> =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; value: T }
export const roleLabels: Record<MemberRole, string> = { admin: 'Admin', member: 'Member' }
const day = 86400000

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
function Expiry({ expiresAt }: { expiresAt: string }) {
  const left = Date.parse(expiresAt) - Date.now()
  if (left <= 0) return <span className="tag">Expired {shortDate(expiresAt)}</span>
  if (left >= 3 * day) return <>{shortDate(expiresAt)}</>
  const hours = Math.ceil(left / 3600000)
  const days = Math.round(left / day)
  return (
    <span className="expires-soon">
      {hours < 24
        ? `In ${hours} ${hours === 1 ? 'hour' : 'hours'}`
        : `In ${days} ${days === 1 ? 'day' : 'days'}`}
    </span>
  )
}
type Notice = { tone: 'error' | 'done'; text: string }
export function MembersPage({
  client,
  session,
  server,
  members,
  revision,
  onInvite,
  onChange,
}: {
  client: Transport
  session: Session
  server: Server
  members: Resource<Member[]>
  revision: number
  onInvite: () => void
  onChange: () => void
}) {
  const pending = useResource(client, '/api/invitations', PendingInvitations, revision)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  async function act(invitation: PendingInvitation, action: 'resend' | 'revoke') {
    setBusy(invitation.email)
    setNotice(null)
    try {
      if (action === 'resend') {
        await client.request('/api/invitations', Invitation, { email: invitation.email })
        setNotice({ tone: 'done', text: `Sent a fresh invitation to ${invitation.email}.` })
      } else {
        await client.request('/api/invitations/revoke', z.object({}), {
          email: invitation.email,
        })
        setNotice({ tone: 'done', text: `Revoked the invitation for ${invitation.email}.` })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) })
    } finally {
      setBusy(null)
      onChange()
    }
  }
  const invitations = pending.kind === 'ready' ? pending.value.invitations : []
  const people = members.kind === 'ready' ? members.value : []
  return (
    <main className="main">
      <header className="topbar">
        <strong>Members</strong>
        <button className="button primary topbar-action" onClick={onInvite}>
          <UserPlus size={15} />
          Invite coworkers
        </button>
      </header>
      <div className="scroll">
        <div className="members">
          <h1>People on {server.name}</h1>
          <p className="members-lede">
            Only people you invite can create an account on this server.
          </p>
          <section aria-labelledby="pending-title">
            <h2 id="pending-title" className="members-heading">
              Pending invitations <span>{invitations.length}</span>
            </h2>
            {notice && (
              <p
                className={notice.tone === 'error' ? 'form-error' : 'members-notice'}
                role={notice.tone === 'error' ? 'alert' : undefined}
                aria-live="polite"
              >
                {notice.text}
              </p>
            )}
            {pending.kind === 'failed' ? (
              <p className="form-error" role="alert">
                {pending.message}
              </p>
            ) : pending.kind === 'ready' && !invitations.length ? (
              <div className="members-empty">
                <span className="mail-mark">
                  <Mail size={16} />
                </span>
                <span>
                  <strong>No pending invitations</strong>
                  <small>Invite coworkers by email. Each invitation lasts 7 days.</small>
                </span>
                <button className="button" onClick={onInvite}>
                  Invite coworkers
                </button>
              </div>
            ) : (
              <table className="card members-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Invited by</th>
                    <th>Expires</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <tr key={invitation.email}>
                      <td>
                        <span className="invite-email">
                          <span className="mail-mark">
                            <Mail size={13} />
                          </span>
                          {invitation.email}
                        </span>
                      </td>
                      <td className="muted">{invitation.invitedBy}</td>
                      <td>
                        <Expiry expiresAt={invitation.expiresAt} />
                      </td>
                      <td className="actions">
                        <button
                          className="button small"
                          disabled={busy !== null}
                          aria-label={`Resend invitation to ${invitation.email}`}
                          onClick={() => void act(invitation, 'resend')}
                        >
                          Resend
                        </button>
                        <button
                          className="link danger"
                          disabled={busy !== null}
                          aria-label={`Revoke invitation for ${invitation.email}`}
                          onClick={() => void act(invitation, 'revoke')}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section aria-labelledby="members-title">
            <h2 id="members-title" className="members-heading">
              Members <span>{people.length}</span>
            </h2>
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
                            size={24}
                          />
                          <span>
                            <strong>
                              {member.name}
                              {member.id === session.user.id && <span> (you)</span>}
                            </strong>
                            <small>{member.email}</small>
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
            )}
            {members.kind === 'ready' && people.length === 1 && (
              <p className="members-footnote">
                You’re the only member so far. People appear here once they accept an invitation and
                finish setting up their account.
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}

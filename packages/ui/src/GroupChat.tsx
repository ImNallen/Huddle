import { Popover } from './Popover'
import { useRef, useState, type FormEvent } from 'react'
import { Users, MoreHorizontal } from 'lucide-react'
import type { Member, Me, UserId } from '@huddle/contracts'
import type { GroupRow, GroupThread } from './chat'
import type { useServer } from './useServer'
import type { Resource } from './Members'
import { errorText, type Transport } from './transport'
import { Avatar } from './Avatar'
import { Overlay } from './primitives'
import { Transcript } from './Transcript'

export function GroupIcon({ size = 28 }: { size?: number }) {
  return (
    <i className="group-avatar" style={{ width: size, height: size }} aria-hidden="true">
      <Users size={size > 30 ? 20 : 16} strokeWidth={1.6} />
    </i>
  )
}
export function GroupConversation({
  group,
  members,
  onMembers,
  onSettings,
  ...shared
}: {
  group: GroupRow
  members: Member[] | null
  onMembers: () => void
  onSettings: () => void
  client: Transport
  me: Me
  sync: ReturnType<typeof useServer>
  draft: string
  onDraft: (value: string) => void
}) {
  const others = group.members
    .filter((m) => m.userId !== shared.me.user.id)
    .map((m) => members?.find((p) => p.id === m.userId)?.name ?? 'Member')
  const people = new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }).format([
    'You',
    ...others,
  ])
  return (
    <Transcript
      {...shared}
      thread={group.thread}
      label={`Message ${group.name}`}
      placeholder={`Message ${group.name}`}
      topbar={
        <header className="topbar group-topbar">
          <GroupIcon size={36} />
          <div className="direct-person">
            <strong>{group.name}</strong>
            <span>
              {group.members.length} {group.members.length === 1 ? 'person' : 'people'}
            </span>
          </div>
          <div className="channel-actions">
            <button className="header-pill" onClick={onMembers}>
              <Users size={16} strokeWidth={1.6} />
              Members · {group.members.length}
            </button>
            <button
              className="icon-button"
              aria-label="Group details"
              data-tooltip="Group details"
              popoverTarget="group-details"
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
          <Popover
            id="group-details"
            role="region"
            label="Group details"
            className="direct-details"
          >
            <h2 id="group-details-title">Group details</h2>
            <p>
              People added to this group can read earlier messages. Messages are stored on this
              server unencrypted, so its host could read them.
            </p>
            <button
              className="button small"
              onClick={(event) => {
                event.currentTarget.parentElement?.hidePopover()
                onSettings()
              }}
            >
              Settings
            </button>
          </Popover>
        </header>
      }
      welcome={
        <>
          <h1 aria-label={`Conversation in ${group.name}`}>A plan worth getting together for.</h1>
          <p>{people}</p>
        </>
      }
    />
  )
}
export function GroupPeopleDialog({
  client,
  me,
  members,
  group,
  sync,
  onClose,
  onCreated,
}: {
  client: Transport
  me: Me
  members: Resource<Member[]>
  group?: GroupRow
  sync: ReturnType<typeof useServer>
  onClose: () => void
  onCreated: (thread: GroupThread) => void
}) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<UserId>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const attempt = useRef<{ fingerprint: string; retryId: string } | null>(null)
  const others =
    members.kind === 'ready'
      ? members.value.filter(
          (m) => m.id !== me.user.id && !group?.members.some((p) => p.userId === m.id),
        )
      : []
  const limit = 32 - (group?.members.length ?? 1)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const userIds = [...selected].sort()
      if (group) {
        await sync.addGroupPeople(group.thread, userIds)
        onClose()
      } else {
        const fingerprint = JSON.stringify([name.trim(), userIds])
        if (attempt.current?.fingerprint !== fingerprint)
          attempt.current = { fingerprint, retryId: crypto.randomUUID() }
        const thread = await sync.createGroup({
          name: name.trim(),
          others: userIds,
          retryId: attempt.current.retryId,
        })
        if (thread) onCreated(thread)
        else onClose()
      }
    } catch (failure) {
      setError(errorText(failure))
      setBusy(false)
    }
  }
  return (
    <Overlay className="modal group-dialog" labelledBy="group-dialog-title" onClose={onClose}>
      <form onSubmit={submit}>
        <header className="new-message-header">
          <h2 id="group-dialog-title">{group ? 'Add people' : 'New group'}</h2>
          <button type="button" className="new-message-cancel" onClick={onClose}>
            Cancel
          </button>
        </header>
        {!group && (
          <label className="group-name">
            Group name
            <input
              autoFocus
              required
              maxLength={60}
              placeholder="e.g. Weekend plans"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
          </label>
        )}
        {group && <p className="group-history-note">New people can read earlier messages.</p>}
        <div className="group-people-heading">
          <span>{group ? 'People on this server' : 'Add people'}</span>
          <span>{selected.size} selected</span>
        </div>
        {members.kind === 'loading' ? (
          <p role="status">Loading people…</p>
        ) : members.kind === 'failed' ? (
          <p role="alert">{members.message}</p>
        ) : !others.length ? (
          <p className="group-history-note">
            {group
              ? 'Everyone on this server is already here.'
              : 'Invite at least two friends to start a group.'}
          </p>
        ) : null}
        <div className="group-people-list">
          {others.map((member) => (
            <label
              className={`group-person ${selected.has(member.id) ? 'selected' : ''}`}
              key={member.id}
            >
              <Avatar
                avatar={member.avatar}
                name={member.name}
                photo={client.photo?.bind(client)}
                size={28}
              />
              <span className="group-person-name">{member.name}</span>
              <input
                type="checkbox"
                aria-label={member.name}
                checked={selected.has(member.id)}
                disabled={busy || (!selected.has(member.id) && selected.size >= limit)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current)
                    if (event.target.checked) next.add(member.id)
                    else next.delete(member.id)
                    return next
                  })
                }
              />
            </label>
          ))}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="group-dialog-footer">
          <span>
            {group
              ? `${limit} ${limit === 1 ? 'place' : 'places'} available`
              : 'You’re included automatically.'}
          </span>
          <button
            className="button primary"
            disabled={busy || (!name.trim() && !group) || selected.size < (group ? 1 : 2)}
          >
            {busy ? 'Please wait…' : group ? 'Add people' : 'Create group'}
          </button>
        </footer>
      </form>
    </Overlay>
  )
}
export function GroupMembersDialog({
  group,
  members,
  client,
  me,
  onAdd,
  onClose,
  onLeave,
}: {
  group: GroupRow
  members: Member[] | null
  client: Transport
  me: Me
  onAdd: () => void
  onClose: () => void
  onLeave: () => Promise<void>
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Overlay
      className="modal group-dialog group-members-dialog"
      labelledBy="group-members-title"
      onClose={onClose}
    >
      <header className="group-members-header">
        <h2 id="group-members-title">{group.name}</h2>
        <span>
          {group.members.length} {group.members.length === 1 ? 'person' : 'people'}
        </span>
      </header>
      <ul className="group-people-list">
        {group.members.map(({ userId }) => {
          const person =
            members?.find((m) => m.id === userId) ?? (userId === me.user.id ? me.user : null)
          return (
            <li className="group-person" key={userId}>
              <Avatar
                avatar={person?.avatar}
                name={person?.name ?? 'Member'}
                photo={client.photo?.bind(client)}
                size={28}
              />
              <span className="group-person-name">{person?.name ?? 'Member'}</span>
              {userId === me.user.id && <small>You</small>}
            </li>
          )
        })}
      </ul>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer className="group-dialog-footer">
        <button className="button" onClick={onAdd} disabled={busy || group.members.length >= 32}>
          Add people
        </button>
        <button
          className="group-leave"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void onLeave().catch((failure) => {
              setError(errorText(failure))
              setBusy(false)
            })
          }}
        >
          {busy ? 'Leaving…' : 'Leave group'}
        </button>
      </footer>
    </Overlay>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Check, Smile } from 'lucide-react'
import { emojiCatalog, type UserId } from '@huddle/contracts'
import type { ThreadMessage } from './chat'
import { Emoji } from './Emoji'
import { EmojiPicker } from './EmojiPicker'
import { Popover } from './Popover'
import { Avatar } from './Avatar'
import { errorText, type Transport } from './transport'

type Attempt = { emoji: string; present: boolean; retryId: string } & (
  | { kind: 'saving' }
  | { kind: 'failed'; error: string }
)
export function MessageReactions({
  message,
  userId,
  photo,
  closed,
  react,
}: {
  message: ThreadMessage
  userId: UserId
  photo?: Transport['photo']
  closed: boolean
  react: (message: ThreadMessage, emoji: string, present: boolean, retryId: string) => Promise<void>
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const alive = useRef(true)
  const available = useRef(!closed)
  available.current = !closed
  const generation = useRef(0)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (closed) {
      generation.current++
      setAttempt(null)
    }
  }, [closed])
  const anchor = useRef<HTMLButtonElement>(null)
  const picker = `reaction-picker-${message.id}`
  const details = `reaction-details-${message.id}`
  async function save(next: Attempt) {
    if (closed) return
    const started = generation.current
    setAttempt({ ...next, kind: 'saving' })
    try {
      await react(message, next.emoji, next.present, next.retryId)
      if (alive.current && available.current && generation.current === started) setAttempt(null)
    } catch (error) {
      if (alive.current && available.current && generation.current === started)
        setAttempt({ ...next, kind: 'failed', error: errorText(error) })
    }
  }
  function choose(emoji: string, present: boolean) {
    if (attempt || closed) return
    void save({ kind: 'saving', emoji, present, retryId: crypto.randomUUID() })
  }
  return (
    <div className="message-reactions">
      {message.reactions.map((reaction) => {
        const mine = reaction.people.some((p) => p.id === userId)
        const name = emojiCatalog.find(([s]) => s === reaction.emoji)?.[1] ?? reaction.emoji
        return (
          <button
            key={reaction.emoji}
            type="button"
            className="reaction-pill"
            aria-pressed={mine}
            aria-label={`${name}, ${reaction.people.length}, ${mine ? 'Remove' : 'Add'} reaction`}
            data-tooltip={`${reaction.people
              .slice(0, 3)
              .map((p) => (p.id === userId ? 'You' : p.name))
              .join(
                ', ',
              )}${reaction.people.length > 3 ? ` and ${reaction.people.length - 3} others` : ''} reacted with ${name.toLowerCase()}.`}
            disabled={closed || !!attempt}
            onClick={() => choose(reaction.emoji, !mine)}
          >
            <Emoji symbol={reaction.emoji} />
            <span>{reaction.people.length}</span>
            {mine && <Check size={11} aria-hidden="true" />}
          </button>
        )
      })}
      {!closed && (
        <button
          ref={anchor}
          className="reaction-add button small"
          type="button"
          aria-label="Add reaction"
          popoverTarget={picker}
          disabled={!!attempt}
        >
          <Smile size={15} aria-hidden="true" />
        </button>
      )}
      {!!message.reactions.length && (
        <>
          <button className="reaction-details button small" type="button" popoverTarget={details}>
            View reactions
          </button>
          <Popover id={details} label="Reactions" className="reaction-people">
            <h2>Reactions</h2>
            {message.reactions.map((reaction) => (
              <section key={reaction.emoji}>
                <Emoji symbol={reaction.emoji} />
                {reaction.people.map((person) => (
                  <div key={person.id}>
                    <Avatar name={person.name} avatar={person.avatar} photo={photo} size={24} />
                    <span>{person.name}</span>
                  </div>
                ))}
              </section>
            ))}
          </Popover>
        </>
      )}
      {!closed && (
        <EmojiPicker
          id={picker}
          title={`React to ${message.authorName}’s message`}
          action="Add reaction"
          anchorRef={anchor}
          onInsert={(emoji) => choose(emoji, true)}
        />
      )}
      {!closed && attempt?.kind === 'saving' && <span role="status">Saving reaction…</span>}
      {!closed && attempt?.kind === 'failed' && (
        <span role="alert">
          {attempt.error}{' '}
          <button type="button" className="button small" onClick={() => void save(attempt)}>
            Retry
          </button>
          <button type="button" className="button small" onClick={() => setAttempt(null)}>
            Cancel
          </button>
        </span>
      )}
    </div>
  )
}

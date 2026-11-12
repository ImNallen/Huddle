import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { z } from 'zod'
import {
  parseInvite,
  type AccessCommand,
  type AccessStage,
  type NoIdentityReason,
  type ServerInfo,
} from '@huddle/contracts'
import {
  Alert,
  CopyButton,
  Frame,
  Heading,
  Primary,
  ServerCard,
  useNow,
  type FrameServer,
} from './primitives'
import { clock } from './Badges'
import { NetworkError, RequestError, type AccessErrorCode } from './connection'
import { clearJoinCode, readJoinCode, saveJoinCode } from './joinCode'
import { errorText, type Transport } from './transport'

type Screen = 'setup' | 'join'
type Problem = { lead: string; message?: string; code?: AccessErrorCode }
const copy: Record<Screen, Partial<Record<AccessErrorCode, Problem>>> = {
  setup: {
    invalid: {
      lead: 'This setup code is invalid or has expired.',
      message:
        'Copy the newest code from the server log. It changes each time the server restarts.',
    },
    expired: {
      lead: 'This setup code is invalid or has expired.',
      message:
        'Copy the newest code from the server log. It changes each time the server restarts.',
    },
  },
  join: {
    invalid: {
      lead: "This invite doesn't work.",
      message: 'Ask your host for a new invite link.',
    },
  },
}
const generic: Record<AccessErrorCode, Problem> = {
  invalid: { lead: "That didn't work.", message: 'Check what you entered and try again.' },
  expired: { lead: 'This step has expired.', message: 'Start again to continue.' },
  rate_limited: { lead: 'Too many attempts.', message: 'Wait a moment, then try again.' },
  unavailable: {
    lead: "This isn't available right now.",
    message: 'Try again in a few minutes, or ask an admin of this server for help.',
  },
  no_access: {
    lead: 'Tailscale no longer says this is you.',
    message: 'Check that it is connected, then try again.',
  },
}
function describe(screen: Screen, failure: unknown): Problem {
  if (failure instanceof NetworkError)
    return { lead: `Can't reach ${failure.host}.`, message: 'Check that Tailscale is connected.' }
  if (failure instanceof RequestError && failure.code) {
    const problem = copy[screen][failure.code] ?? generic[failure.code]
    const retry =
      failure.code === 'rate_limited' && failure.retryAt
        ? `Try again at ${clock(failure.retryAt)}.`
        : undefined
    return { ...problem, message: retry ?? problem.message, code: failure.code }
  }
  return { lead: errorText(failure) }
}
const noIdentity: Record<
  NoIdentityReason,
  { title: string; message: (info: z.infer<typeof ServerInfo>) => ReactNode }
> = {
  'no-user': {
    title: "Tailscale doesn't say who you are",
    message: () =>
      "Tailscale doesn't say who this device belongs to. Tagged devices have no user. Use a device signed in as a person.",
  },
  direct: {
    title: 'Open Huddle through Tailscale',
    message: (info) => (
      <>
        Open <code>{info.serverUrl}</code> with Tailscale connected.
      </>
    ),
  },
  funnel: {
    title: "Huddle isn't available through Funnel",
    message: () => 'Ask the host to turn Funnel off for this server.',
  },
}
function ProblemAlert({ problem }: { problem: Problem | null }) {
  return problem ? <Alert lead={problem.lead} message={problem.message} /> : null
}
function Identity({ login }: { login: string }) {
  return (
    <p className="access-identity">
      Tailscale says you're <code>{login}</code>
    </p>
  )
}
function HadAccount({
  login,
  busy,
  onCheck,
}: {
  login: string
  busy: boolean
  onCheck: () => void
}) {
  return (
    <section className="access-had-account">
      <h2>Been here before?</h2>
      <p>
        Ask your admin to link this Tailscale login to your existing account before creating a new
        one.
      </p>
      <div className="access-account-actions">
        <CopyButton value={login} label="Copy login" />
        <button type="button" className="access-secondary" disabled={busy} onClick={onCheck}>
          Check again
        </button>
      </div>
    </section>
  )
}

export function Access({
  client,
  act,
  recheck,
  stage,
  info,
  onServer,
}: {
  client: Transport
  act: (command: AccessCommand, signal: AbortSignal) => Promise<void>
  recheck: () => Promise<void>
  stage: Exclude<AccessStage, { kind: 'ready' }>
  info: z.infer<typeof ServerInfo>
  onServer?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(
    stage.kind === 'setup' || stage.kind === 'join' ? stage.suggestedName : '',
  )
  const [failure, setFailure] = useState<{ screen: Screen; error: unknown } | null>(null)
  const [retryAt, setRetryAt] = useState(0)
  const [joinCode, setJoinCode] = useState(() => readJoinCode(client.origin))
  const [inviteProblem, setInviteProblem] = useState('')
  const [checked, setChecked] = useState(false)
  const now = useNow()
  const working = busy || retryAt > now
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    lifetime.current = new AbortController()
    return () => lifetime.current.abort()
  }, [client])
  function submit(
    screen: Screen,
    event: FormEvent<HTMLFormElement>,
    command: (form: FormData) => AccessCommand,
  ) {
    event.preventDefault()
    const signal = lifetime.current.signal
    const next = command(new FormData(event.currentTarget))
    setBusy(true)
    setFailure(null)
    setRetryAt(0)
    void act(next, signal)
      .catch((error: unknown) => {
        if (signal.aborted || !client.active) return
        setFailure({ screen, error })
        if (error instanceof RequestError && error.retryAt) setRetryAt(Date.parse(error.retryAt))
        if (screen === 'join' && error instanceof RequestError && error.code === 'invalid') {
          clearJoinCode(client.origin)
          setJoinCode(null)
        }
      })
      .finally(() => {
        if (!signal.aborted && client.active) setBusy(false)
      })
  }
  function acceptInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    try {
      const invite = parseInvite(z.string().parse(new FormData(event.currentTarget).get('invite')))
      if (invite.origin !== client.origin) {
        setInviteProblem(`That invite is for ${new URL(invite.origin).host}. Open it there.`)
        return
      }
      saveJoinCode(client.origin, invite.code)
      setJoinCode(invite.code)
      setInviteProblem('')
    } catch (error) {
      setInviteProblem(errorText(error))
    }
  }
  function checkAgain() {
    setBusy(true)
    setChecked(false)
    setFailure(null)
    void recheck()
      .then(
        () => setChecked(true),
        (error: unknown) => setFailure({ screen: 'join', error }),
      )
      .finally(() => setBusy(false))
  }
  function problemOn(screen: Screen) {
    return failure?.screen === screen ? describe(screen, failure.error) : null
  }
  const server: FrameServer =
    info.setup === 'complete'
      ? { name: info.name, origin: client.origin }
      : { origin: client.origin }
  switch (stage.kind) {
    case 'no-identity': {
      const { title, message } = noIdentity[stage.reason]
      return (
        <Frame>
          <ServerCard server={server} onServer={onServer} />
          <Heading title={title} description={message(info)} />
          <Primary type="button" busy={busy} onClick={checkAgain}>
            Try again
          </Primary>
          <ProblemAlert problem={problemOn('join')} />
          {checked && !busy && (
            <p className="access-footer" role="status">
              Nothing has changed yet.
            </p>
          )}
        </Frame>
      )
    }
    case 'removed':
      return (
        <Frame>
          <ServerCard server={server} onServer={onServer} />
          <Heading
            title={`You were removed from ${server.name ?? 'this server'}`}
            description="If that was a mistake, ask an admin to unblock you. Then open your invite link again."
          />
          <Identity login={stage.login} />
          <Primary type="button" busy={busy} onClick={checkAgain}>
            Check again
          </Primary>
          <ProblemAlert problem={problemOn('join')} />
          {checked && !busy && (
            <p className="access-footer" role="status">
              Nothing has changed yet.
            </p>
          )}
        </Frame>
      )
    case 'setup': {
      const problem = problemOn('setup')
      const codeProblem =
        problem?.code === 'invalid' || problem?.code === 'expired' ? problem : null
      return (
        <Frame>
          <Heading
            title="A place for your people."
            label="Set up this server"
            description="Name this server and create the first account. Share an invite with friends once you’re in."
            back={onServer}
          />
          <Identity login={stage.login} />
          <form
            onSubmit={(event) =>
              submit('setup', event, (form) => ({
                kind: 'account.setup',
                code: z.string().parse(form.get('code')),
                serverName: z.string().parse(form.get('serverName')),
                name: z.string().parse(form.get('name')),
              }))
            }
          >
            <label className="access-label">
              Setup code
              <input
                className="access-mono"
                name="code"
                required
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                aria-invalid={codeProblem ? true : undefined}
              />
            </label>
            {codeProblem && <Alert lead={codeProblem.lead} message={codeProblem.message} />}
            <label className="access-label">
              Server name
              <input name="serverName" required maxLength={60} placeholder="e.g. Saturday crew" />
            </label>
            <label className="access-label">
              Your name
              <input
                name="name"
                required
                maxLength={80}
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <Primary busy={busy} disabled={working}>
              Create the server
            </Primary>
          </form>
          {!codeProblem && <ProblemAlert problem={problem} />}
          {!codeProblem && (
            <p className="access-footer">
              Find the setup code in the server log. It works once and changes when the server
              restarts.
            </p>
          )}
        </Frame>
      )
    }
    case 'join':
      return (
        <Frame>
          <ServerCard server={server} onServer={onServer} />
          <Heading
            title={`Join ${info.name}`}
            description={
              joinCode
                ? 'Check your name, then create your account. It lives on this server.'
                : 'You need an invite link from an admin of this server to create an account.'
            }
          />
          <Identity login={stage.login} />
          {joinCode ? (
            <form
              key="create-account"
              onSubmit={(event) =>
                submit('join', event, (form) => ({
                  kind: 'account.join',
                  code: joinCode,
                  name: z.string().parse(form.get('name')),
                }))
              }
            >
              <label className="access-label">
                Your name
                <input
                  name="name"
                  required
                  maxLength={80}
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <Primary busy={busy} disabled={working}>
                Create account
              </Primary>
            </form>
          ) : (
            <form key="accept-invite" onSubmit={acceptInvite} noValidate>
              <label className="access-label">
                Invite link
                <input
                  className="access-mono"
                  name="invite"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={`${client.origin}/#join=…`}
                  aria-invalid={inviteProblem ? true : undefined}
                  onChange={() => setInviteProblem('')}
                />
              </label>
              <Primary disabled={working}>Continue</Primary>
            </form>
          )}
          <Alert message={inviteProblem} />
          <ProblemAlert problem={problemOn('join')} />
          <HadAccount login={stage.login} busy={working} onCheck={checkAgain} />
          {checked && !busy && (
            <p className="access-footer" role="status">
              This login isn't linked to an account yet.
            </p>
          )}
        </Frame>
      )
  }
}

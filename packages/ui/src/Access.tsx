import { useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { type AccessCommand, type AccessView, type ServerInfo } from '@huddle/contracts'
import { Alert, Frame, Heading, Primary, ServerCard, useNow, type FrameServer } from './primitives'
import { NetworkError, RequestError, type AccessErrorCode } from './connection'
import { errorText, type Transport } from './transport'

type Screen = 'setup' | 'signin'
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
  signin: {
    invalid: {
      lead: "That username or password isn't right.",
      message: 'Check both and try again.',
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
  reauth_required: {
    lead: 'Please confirm who you are again.',
    message: 'For your security, sign in again to continue.',
  },
}
function describe(screen: Screen, failure: unknown): Problem {
  if (failure instanceof NetworkError)
    return { lead: `Can't reach ${failure.host}.`, message: 'Check your connection and try again.' }
  if (failure instanceof RequestError && failure.code) {
    const problem = copy[screen][failure.code] ?? generic[failure.code]
    const retry =
      failure.code === 'rate_limited' && failure.retryAt
        ? `Try again at ${new Date(failure.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        : undefined
    return { ...problem, message: retry ?? problem.message, code: failure.code }
  }
  return { lead: errorText(failure) }
}
function ProblemAlert({ problem }: { problem: Problem | null }) {
  return problem ? <Alert lead={problem.lead} message={problem.message} /> : null
}
export function Access({
  client,
  act,
  view,
  info,
  onServer,
}: {
  client: Transport
  act: (command: AccessCommand, signal: AbortSignal) => Promise<void>
  view: AccessView
  info: z.infer<typeof ServerInfo>
  onServer?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ screen: Screen; error: unknown } | null>(null)
  const [retryAt, setRetryAt] = useState(0)
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
      })
      .finally(() => {
        if (!signal.aborted && client.active) setBusy(false)
      })
  }
  function problemOn(screen: Screen) {
    return failure?.screen === screen ? describe(screen, failure.error) : null
  }
  const stage = view.stage
  const server: FrameServer =
    info.setup === 'complete'
      ? { name: info.name, origin: client.origin }
      : { origin: client.origin }
  switch (stage.kind) {
    case 'setup': {
      const problem = problemOn('setup')
      const codeProblem =
        problem?.code === 'invalid' || problem?.code === 'expired' ? problem : null
      return (
        <Frame server={server} onServer={onServer}>
          <ServerCard
            server={server}
            label="New server"
            onServer={onServer}
            serverLabel="Change server"
          />
          <Heading
            title="Set up this server"
            description="Name this server and create the first account. The setup code is in the server log. Friends join later with the invite you copy from Huddle."
          />
          <form
            onSubmit={(event) =>
              submit('setup', event, (form) => ({
                kind: 'account.setup',
                code: z.string().parse(form.get('code')),
                serverName: z.string().parse(form.get('serverName')),
                username: z.string().parse(form.get('username')),
                password: z.string().parse(form.get('password')),
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
              Username
              <input
                name="username"
                required
                minLength={2}
                maxLength={32}
                autoComplete="username"
                spellCheck={false}
                placeholder="ada"
              />
            </label>
            <label className="access-label">
              Password
              <input
                name="password"
                type="password"
                required
                minLength={8}
                maxLength={200}
                autoComplete="new-password"
              />
            </label>
            <Primary busy={busy} disabled={working}>
              Create the server
            </Primary>
          </form>
          {!codeProblem && <ProblemAlert problem={problem} />}
          <p className="access-footer">
            The setup code is in the server log. It works once and changes each time the server
            restarts.
          </p>
        </Frame>
      )
    }
    case 'signin': {
      const joinCode =
        typeof localStorage === 'undefined'
          ? null
          : localStorage.getItem(`huddle.join-code:${client.origin}`)
      return (
        <Frame server={server} onServer={onServer}>
          <ServerCard server={server} onServer={onServer} />
          <Heading
            title={`Sign in to ${info.name}`}
            description="Your account lives on this server."
          />
          {joinCode && (
            <>
              <form
                onSubmit={(event) =>
                  submit('signin', event, (form) => ({
                    kind: 'account.join',
                    code: joinCode,
                    username: z.string().parse(form.get('username')),
                    password: z.string().parse(form.get('password')),
                  }))
                }
              >
                <label className="access-label">
                  Username
                  <input
                    name="username"
                    required
                    minLength={2}
                    maxLength={32}
                    autoComplete="username"
                    spellCheck={false}
                  />
                </label>
                <label className="access-label">
                  Password
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={8}
                    maxLength={200}
                    autoComplete="new-password"
                  />
                </label>
                <Primary busy={busy} disabled={working}>
                  Create account
                </Primary>
              </form>
              <div className="access-divider">or</div>
            </>
          )}
          <form
            onSubmit={(event) =>
              submit('signin', event, (form) => ({
                kind: 'account.signin',
                username: z.string().parse(form.get('username')),
                password: z.string().parse(form.get('password')),
              }))
            }
          >
            <label className="access-label">
              Username
              <input
                name="username"
                required
                minLength={2}
                maxLength={32}
                autoComplete="username"
                spellCheck={false}
              />
            </label>
            <label className="access-label">
              Password
              <input
                name="password"
                type="password"
                required
                minLength={8}
                maxLength={200}
                autoComplete="current-password"
              />
            </label>
            <Primary busy={busy} disabled={working}>
              Sign in
            </Primary>
          </form>
          <ProblemAlert problem={problemOn('signin')} />
          <div className="access-footer">
            <p>Need access? Ask an admin of this server for an invite.</p>
          </div>
        </Frame>
      )
    }
    case 'ready':
      return null
  }
}

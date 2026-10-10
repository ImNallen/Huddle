import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Building2,
  Check,
  Clock,
  Download,
  ExternalLink,
  Globe,
  Key,
  KeyRound,
  LifeBuoy,
  Mail,
  Monitor,
  Smartphone,
  UserRound,
} from 'lucide-react'
import QRCode from 'qrcode'
import { z } from 'zod'
import {
  type AccessCommand,
  type AccessView,
  type AccessStage,
  type Inviter,
  type Profile,
  type ServerInfo,
} from '@huddle/contracts'
import {
  Alert,
  CodeField,
  CopyButton,
  Countdown,
  Expiry,
  Frame,
  Heading,
  Primary,
  ServerCard,
  ServerTile,
  Steps,
  hostOf,
  useNow,
  type FrameServer,
  type Tone,
} from './primitives'
import { ProfileEditor, Avatar } from './Avatar'
import { NetworkError, RequestError, type AccessErrorCode } from './connection'
import { errorText, type Transport } from './transport'
import { addPasskey, signInPasskey } from './passkeys'

export interface AccessAdapter {
  act(command: AccessCommand, signal?: AbortSignal): Promise<AccessView>
  accept(view: AccessView, signal?: AbortSignal): Promise<void>
  company(signal: AbortSignal, setup?: { code: string; serverName: string }): Promise<void>
  browser?(): Promise<void>
  openBrowser?(url: string): Promise<void>
  upload(file: File): Promise<string>
  photo(id: string, signal: AbortSignal): Promise<string>
}
type Screen = 'setup' | 'signin' | 'email' | 'enroll' | 'totp' | 'recovery' | 'reset' | 'other'
type Problem = { lead: string; message?: string; tone?: Tone; code?: AccessErrorCode }
const copy: Partial<Record<Screen, Partial<Record<AccessErrorCode, Problem>>>> = {
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
  email: {
    invalid: {
      lead: "That code isn't right.",
      message: 'Check the newest email from Huddle and try again.',
    },
  },
  enroll: {
    invalid: {
      lead: "That code doesn't match.",
      message: 'Make sure your phone sets its time automatically, then enter the newest code.',
    },
  },
  totp: {
    invalid: {
      lead: "That code isn't right.",
      message: 'Codes change every 30 seconds. Enter the one your app shows now.',
    },
  },
  recovery: {
    invalid: {
      lead: "That code isn't valid or was already used.",
      message: 'Check for typos, or try another code from your list.',
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
    const problem = copy[screen]?.[failure.code] ?? generic[failure.code]
    const retry =
      failure.code === 'rate_limited' && failure.retryAt
        ? `Try again at ${new Date(failure.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        : undefined
    return { ...problem, message: retry ?? problem.message, code: failure.code }
  }
  return { lead: errorText(failure) }
}
function ProblemAlert({ problem }: { problem: Problem | null }) {
  return problem ? (
    <Alert lead={problem.lead} message={problem.message} tone={problem.tone} />
  ) : null
}
export function Access({
  client,
  adapter,
  view,
  info,
  account,
  notice = '',
  onServer,
  onSignOut,
  fromSecurity = false,
}: {
  client: Transport
  adapter: AccessAdapter
  view: AccessView
  info: z.infer<typeof ServerInfo>
  account?: string
  notice?: string
  onServer?: () => void
  onSignOut?: () => void
  fromSecurity?: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ screen: Screen; error: unknown } | null>(null)
  const [retryAt, setRetryAt] = useState(0)
  const now = useNow()
  const working = busy !== null || retryAt > now
  const [reset, setReset] = useState<{ requested: string | null } | null>(null)
  const [started, setStarted] = useState(false)
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    lifetime.current = new AbortController()
    return () => lifetime.current.abort()
  }, [client])
  async function run(screen: Screen, key: string, action: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current.signal
    setBusy(key)
    setFailure(null)
    setRetryAt(0)
    try {
      await action(signal)
    } catch (error) {
      if (!signal.aborted && client.active) {
        setFailure({ screen, error })
        if (error instanceof RequestError && error.retryAt) setRetryAt(Date.parse(error.retryAt))
      }
    } finally {
      if (!signal.aborted && client.active) setBusy(null)
    }
  }
  function act(screen: Screen, command: AccessCommand, key: string = command.kind) {
    return run(screen, key, async (signal) =>
      adapter.accept(await adapter.act(command, signal), signal),
    )
  }
  function submit(
    screen: Screen,
    event: FormEvent<HTMLFormElement>,
    command: (form: FormData) => AccessCommand,
  ) {
    event.preventDefault()
    void act(screen, command(new FormData(event.currentTarget)), 'submit')
  }
  function problemOn(screen: Screen) {
    return failure?.screen === screen ? describe(screen, failure.error) : null
  }
  const stage = view.stage
  const desktop = Boolean(adapter.browser)
  const server: FrameServer =
    info.setup === 'complete'
      ? { name: info.name, origin: client.origin }
      : { origin: client.origin }
  const signedOut = stage.kind === 'signin' || stage.kind === 'setup'
  const frame = {
    server,
    account: stage.kind === 'email' ? stage.email : signedOut ? undefined : account,
    onServer,
    onSignOut: signedOut || stage.kind === 'email' ? undefined : onSignOut,
  }
  if (reset) {
    const problem = problemOn('reset')
    return (
      <Frame
        {...frame}
        onSignIn={stage.kind === 'signin' && !desktop ? () => setReset(null) : undefined}
      >
        {reset.requested ? (
          <>
            <Heading
              title="Request sent"
              icon={<Check size={16} />}
              iconTone="success"
              description="If this account can be recovered, the server operator will review your request. Contact your company's support team to confirm your identity."
            />
            <div className="access-summary" role="status">
              <Mail size={14} />
              Requested for
              <strong>{reset.requested}</strong>
            </div>
            <button type="button" className="access-secondary" onClick={() => setReset(null)}>
              Back to sign in
            </button>
            <p className="access-footer">
              For your safety, this page looks the same whether or not an account exists.
            </p>
          </>
        ) : (
          <>
            <Heading
              title="Request account recovery"
              icon={<LifeBuoy size={16} />}
              back={() => setReset(null)}
              description="If you've lost every way to sign in, the server operator can reset your account. They'll confirm who you are before anything changes."
            />
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const email = z.string().parse(new FormData(event.currentTarget).get('email'))
                void run('reset', 'submit', async (signal) => {
                  await adapter.act({ kind: 'reset.request', email }, signal)
                  setReset({ requested: email })
                })
              }}
            >
              <label className="access-label">
                Account email
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@company.com"
                  defaultValue={account}
                />
              </label>
              <ProblemAlert problem={problem} />
              <Primary busy={busy === 'submit'} disabled={working}>
                Request a reset
              </Primary>
            </form>
            <hr className="access-rule" />
            <ol className="access-steps-list">
              <li>
                <span>1</span>The operator reviews your request.
              </li>
              <li>
                <span>2</span>Your company's support team confirms your identity.
              </li>
              <li>
                <span>3</span>You get a one-time link to set up sign-in again.
              </li>
            </ol>
          </>
        )}
      </Frame>
    )
  }
  switch (stage.kind) {
    case 'setup': {
      const problem = problemOn('setup')
      const codeProblem =
        problem?.code === 'invalid' || problem?.code === 'expired' ? problem : null
      const email = stage.methods.includes('email')
      const company = stage.methods.includes('company')
      const companyHere = company && !desktop
      const finishInBrowser = !email && company && desktop
      return (
        <Frame {...frame}>
          <ServerCard
            server={server}
            label="New server"
            onServer={onServer}
            serverLabel="Change server"
          />
          <Heading
            title="Set up this server"
            description="This Huddle server is not set up yet. Name it and create the first admin account. Everyone else joins by invitation."
          />
          {finishInBrowser ? (
            <>
              <div className="access-card">
                <h2>
                  <Globe size={14} />
                  Finish setup in your browser
                </h2>
                <p>
                  This server only allows company login, which can't run inside the desktop app
                  during setup. Open the address below in a browser, then come back here.
                </p>
                <div className="access-key">
                  <code>{`${hostOf(client.origin)}/login`}</code>
                  <CopyButton value={`${client.origin}/login`} label="Copy address" iconOnly />
                </div>
              </div>
              {adapter.openBrowser && (
                <Primary
                  type="button"
                  busy={busy === 'open'}
                  disabled={working}
                  onClick={() =>
                    void run('setup', 'open', async () => {
                      await adapter.openBrowser?.(`${client.origin}/login`)
                    })
                  }
                >
                  <ExternalLink size={14} />
                  Open browser to finish
                </Primary>
              )}
            </>
          ) : (
            <SetupForm
              email={email}
              company={companyHere}
              emailAvailable={info.emailAvailable}
              busy={busy}
              working={working}
              codeProblem={codeProblem}
              onEmail={(command) => void act('setup', command, 'email')}
              onCompany={(setup) =>
                void run('setup', 'company', (signal) => adapter.company(signal, setup))
              }
            />
          )}
          {!codeProblem && <ProblemAlert problem={problem} />}
          <Alert message={notice} />
          <p className="access-footer">
            The setup code is in the server log. It works once and changes each time the server
            restarts.
          </p>
        </Frame>
      )
    }
    case 'signin': {
      const problem = problemOn('signin')
      const email = stage.methods.includes('email')
      const passkey = stage.methods.includes('passkey')
      const company = stage.methods.includes('company')
      const alternatives = [company && 'company login', passkey && 'a passkey'].filter(Boolean)
      const companyButton = company && (
        <button
          type="button"
          className={email ? 'access-secondary' : 'access-primary'}
          disabled={working}
          onClick={() => void run('signin', 'company', adapter.company)}
        >
          <Building2 size={14} />
          Continue with company login
        </button>
      )
      return (
        <Frame {...frame}>
          <ServerCard server={server} onServer={onServer} />
          <Heading
            title={`Sign in to ${info.name}`}
            description="Your account lives on this server."
          />
          {companyButton}
          {company && email && <div className="access-divider">or</div>}
          {email && (
            <form
              onSubmit={(event) =>
                submit('signin', event, (form) => ({
                  kind: 'email.send',
                  email: z.string().parse(form.get('email')),
                }))
              }
            >
              <label className="access-label">
                Work email
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@company.com"
                  disabled={!info.emailAvailable}
                />
              </label>
              {info.emailAvailable ? (
                <Primary busy={busy === 'submit'} disabled={working}>
                  Continue with email
                </Primary>
              ) : (
                <Alert
                  tone="warning"
                  icon={<Mail size={14} />}
                  lead="Email sign-in is unavailable right now."
                  message={`This server can't send email at the moment.${
                    alternatives.length ? ` Use ${alternatives.join(' or ')} instead.` : ''
                  }`}
                />
              )}
            </form>
          )}
          {passkey && (
            <button
              type="button"
              className="access-secondary"
              disabled={working}
              onClick={() =>
                void run('signin', 'passkey', async (signal) => {
                  if (adapter.browser) await adapter.browser()
                  else await adapter.accept(await signInPasskey(client, signal), signal)
                })
              }
            >
              <KeyRound size={14} />
              Sign in with a passkey
            </button>
          )}
          {adapter.browser && (
            <button
              type="button"
              className="access-secondary"
              disabled={working}
              onClick={() =>
                void run('signin', 'browser', () => adapter.browser?.() ?? Promise.resolve())
              }
            >
              <Monitor size={14} />
              Sign in in your browser
            </button>
          )}
          <ProblemAlert problem={problem} />
          <Alert message={notice} />
          <div className="access-footer">
            <p>Need access? Ask an admin of this server for an invite.</p>
            {email && (
              <p>
                Lost access to your sign-in methods?{' '}
                <button
                  type="button"
                  className="access-link"
                  onClick={() => setReset({ requested: null })}
                >
                  Recover your account
                </button>
              </p>
            )}
          </div>
        </Frame>
      )
    }
    case 'email': {
      const problem = problemOn('email')
      const expired = Date.parse(stage.expiresAt) <= now || problem?.code === 'expired'
      const resend = () => void act('email', { kind: 'email.send', email: stage.email }, 'resend')
      return (
        <Frame {...frame}>
          <Heading
            title="Check your email"
            icon={<Mail size={16} />}
            back={onSignOut}
            backLabel="Use a different email"
            description={
              <>
                We sent a 6-digit code to <strong>{stage.email}</strong> to verify your address.
              </>
            }
          />
          <form
            onSubmit={(event) => {
              if (!expired)
                return submit('email', event, (form) => ({
                  kind: 'email.verify',
                  code: z.string().parse(form.get('code')),
                }))
              event.preventDefault()
              resend()
            }}
          >
            <CodeField
              key={stage.expiresAt}
              label="Verification code"
              aside={<Expiry expiresAt={stage.expiresAt} now={now} expired={expired} />}
              invalid={problem?.code === 'invalid'}
              expired={expired}
            />
            {expired ? (
              <Alert
                tone="warning"
                icon={<Clock size={14} />}
                lead="This code has expired."
                message="Codes last 5 minutes. Send a new one to continue."
              />
            ) : (
              <ProblemAlert problem={problem} />
            )}
            <Primary busy={busy !== null} disabled={working}>
              {expired ? 'Send a new code' : 'Verify'}
            </Primary>
          </form>
          {!expired && (
            <div className="access-footer">
              <p>Didn't get it? Check your spam folder.</p>
              <Resend resendAt={stage.resendAt} now={now} busy={working} resend={resend} />
            </div>
          )}
        </Frame>
      )
    }
    case 'enroll': {
      if (!stage.replacing && stage.inviter && !started)
        return (
          <Frame {...frame}>
            <Welcome
              server={info.name}
              inviter={stage.inviter}
              photo={adapter.photo}
              start={() => setStarted(true)}
            />
          </Frame>
        )
      return (
        <Frame {...frame} wide>
          {!stage.replacing && <Steps step={1} />}
          <Heading
            title={stage.replacing ? 'Replace your authenticator' : 'Set up your authenticator'}
            back={
              stage.replacing && fromSecurity
                ? () => void act('enroll', { kind: 'totp.choose' }, 'back')
                : undefined
            }
            backLabel="Account security"
            description={
              stage.replacing
                ? 'Scan a new QR code with the authenticator app you want to use from now on, then confirm with a code from it.'
                : 'Huddle uses a code from an authenticator app each time you sign in with email. This keeps your account safe even if someone gets access to your inbox.'
            }
          />
          <Enrollment
            stage={stage}
            busy={busy === 'submit'}
            working={working}
            problem={problemOn('enroll')}
            verify={(code) =>
              act(
                'enroll',
                { kind: 'enrollment.verify', generation: stage.generation, code },
                'submit',
              )
            }
          />
        </Frame>
      )
    }
    case 'save-recovery':
      return (
        <Frame {...frame} wide>
          <Steps step={2} />
          <Heading
            title="Save your recovery codes"
            description="If you lose your authenticator and your passkeys, each of these codes signs you in once. Keep them somewhere safe, like your password manager."
          />
          <RecoverySave
            stage={stage}
            busy={busy !== null}
            working={working}
            acknowledge={() => void act('other', { kind: 'recovery.ack', batch: stage.batch })}
          />
          <ProblemAlert problem={problemOn('other')} />
        </Frame>
      )
    case 'passkey-offer':
      return (
        <Frame {...frame} wide>
          <Steps step={3} />
          <Heading
            title="Add a passkey"
            icon={<KeyRound size={16} />}
            description="Next time, sign in with your fingerprint, face or device PIN instead of a code. Passkeys can't be phished."
          />
          {adapter.openBrowser && (
            <Alert
              tone="info"
              message={
                <>
                  Passkeys are added in your browser. We'll open{' '}
                  <code>{hostOf(client.origin)}</code> there. Add the passkey, then come back here
                  to continue.
                </>
              }
            />
          )}
          <Primary
            type="button"
            busy={busy === 'passkey'}
            disabled={working}
            onClick={() =>
              void run('other', 'passkey', async (signal) => {
                if (adapter.openBrowser)
                  await adapter.openBrowser(`${client.origin}/login?settings=security`)
                else await adapter.accept(await addPasskey(client, 'My passkey', signal), signal)
              })
            }
          >
            {adapter.openBrowser ? <ExternalLink size={14} /> : <KeyRound size={14} />}
            {adapter.openBrowser ? 'Add passkey in browser' : 'Add passkey'}
          </Primary>
          <button
            type="button"
            className="access-text-button"
            disabled={working}
            onClick={() => void act('other', { kind: 'passkey.skip' })}
          >
            Skip for now
          </button>
          <ProblemAlert problem={problemOn('other')} />
          <p className="access-footer is-center">
            You can add or remove passkeys any time in Account security.
          </p>
        </Frame>
      )
    case 'totp': {
      const problem = problemOn('totp')
      return (
        <Frame {...frame}>
          <Heading
            title="Enter your authenticator code"
            icon={<Smartphone size={16} />}
            description={
              <>
                Open your authenticator app and enter the 6-digit code for{' '}
                <strong>{info.name}</strong>
                {info.name.endsWith('.') ? '' : '.'}
              </>
            }
          />
          <form
            onSubmit={(event) =>
              submit('totp', event, (form) => ({
                kind: 'totp.verify',
                code: z.string().parse(form.get('code')),
              }))
            }
          >
            <CodeField
              label="Authenticator code"
              aside={<span className="access-aside">New code every 30 seconds</span>}
              invalid={problem?.code === 'invalid'}
            />
            <ProblemAlert problem={problem} />
            <Primary busy={busy === 'submit'} disabled={working}>
              Continue
            </Primary>
          </form>
          <hr className="access-rule" />
          <button
            type="button"
            className="access-link"
            disabled={working}
            onClick={() => void act('totp', { kind: 'recovery.choose' })}
          >
            <Key size={14} />
            Use a recovery code
          </button>
          <p className="access-note">
            Using a passkey? Go back and choose <strong>Sign in with a passkey</strong>.
          </p>
        </Frame>
      )
    }
    case 'recovery': {
      const problem = problemOn('recovery')
      return (
        <Frame {...frame}>
          <Heading
            title="Recover your account"
            icon={<Key size={16} />}
            back={() => void act('recovery', { kind: 'totp.choose' }, 'back')}
            backLabel="Back to authenticator code"
            description="Enter one of the recovery codes you saved when you set up your account. Each code works once."
          />
          <form
            onSubmit={(event) =>
              submit('recovery', event, (form) => ({
                kind: 'recovery.verify',
                code: z.string().parse(form.get('code')).trim(),
              }))
            }
          >
            <label className="access-label">
              Recovery code
              <input
                className="access-mono"
                name="code"
                required
                maxLength={128}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                aria-invalid={problem?.code === 'invalid' || undefined}
              />
            </label>
            <ProblemAlert problem={problem} />
            <Primary busy={busy === 'submit'} disabled={working}>
              Recover account
            </Primary>
          </form>
          <div className="access-card">
            <h2>Lost your authenticator, passkeys and recovery codes?</h2>
            <p>The server operator can reset your sign-in after confirming who you are.</p>
            <button
              type="button"
              className="access-link"
              onClick={() => setReset({ requested: null })}
            >
              Request account recovery
            </button>
          </div>
          <p className="access-footer">
            After recovering, you'll set up a new authenticator and get a new set of recovery codes.
            Your old codes stop working.
          </p>
        </Frame>
      )
    }
    case 'profile':
      return (
        <Frame {...frame} wide>
          <Heading
            eyebrow="Last step"
            title="Complete your profile"
            description="This is how your team sees you in rooms, channels and messages."
          />
          <ProfileEditor
            initial={stage.profile}
            save={(profile: Profile) => act('other', { kind: 'profile.save', profile }, 'submit')}
            busy={busy === 'submit'}
            upload={adapter.upload}
            photo={adapter.photo}
            submitLabel={`Continue to ${info.name}`}
          />
          <ProblemAlert problem={problemOn('other')} />
        </Frame>
      )
    case 'ready':
      return null
    default: {
      const exhaustive: never = stage
      return exhaustive
    }
  }
}
function SetupForm({
  email,
  company,
  emailAvailable,
  busy,
  working,
  codeProblem,
  onEmail,
  onCompany,
}: {
  email: boolean
  company: boolean
  emailAvailable: boolean
  busy: string | null
  working: boolean
  codeProblem: Problem | null
  onEmail: (command: AccessCommand) => void
  onCompany: (setup: { code: string; serverName: string }) => void
}) {
  const [serverName, setServerName] = useState('')
  const [missing, setMissing] = useState(false)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const code = z.string().parse(form.get('code')).trim()
        const name = serverName.trim()
        const submitter = (event.nativeEvent as SubmitEvent).submitter
        if (submitter?.getAttribute('value') !== 'company')
          return onEmail({
            kind: 'setup.start',
            code,
            serverName: name,
            email: z.string().parse(form.get('email')),
          })
        setMissing(!code || !name)
        if (code && name) onCompany({ code, serverName: name })
      }}
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
        <input
          name="serverName"
          required
          maxLength={60}
          placeholder="e.g. Harbor & Co."
          value={serverName}
          onChange={(event) => setServerName(event.target.value)}
        />
      </label>
      {email && (
        <>
          <label className="access-label">
            Admin email
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
            />
          </label>
          <Primary
            busy={busy === 'email'}
            busyLabel={`Setting up ${serverName.trim() || 'this server'}…`}
            disabled={working || !emailAvailable}
          >
            Continue with email
          </Primary>
          {!emailAvailable && (
            <Alert
              tone="warning"
              icon={<Mail size={14} />}
              lead="Email isn't configured on this server."
              message={`Add SMTP settings to the server config to send sign-in codes${
                company ? ', or continue with company login.' : '.'
              }`}
            />
          )}
        </>
      )}
      {email && company && <div className="access-divider">or</div>}
      {company && (
        <button
          className={email ? 'access-secondary' : 'access-primary'}
          name="method"
          value="company"
          formNoValidate
          disabled={working}
        >
          <Building2 size={14} />
          Continue with company login
        </button>
      )}
      {missing && <Alert message="Enter the setup code and a server name." />}
    </form>
  )
}
function Resend({
  resendAt,
  now,
  busy,
  resend,
}: {
  resendAt: string
  now: number
  busy: boolean
  resend: () => void
}) {
  return Date.parse(resendAt) > now ? (
    <p>
      You can resend the code in <Countdown until={resendAt} now={now} />
    </p>
  ) : (
    <p>
      <button type="button" className="access-link" disabled={busy} onClick={resend}>
        Resend code
      </button>
    </p>
  )
}
function Welcome({
  server,
  inviter,
  photo,
  start,
}: {
  server: string
  inviter: Inviter
  photo: (id: string, signal: AbortSignal) => Promise<string>
  start: () => void
}) {
  const plan: { title: string; detail: string; icon?: ReactNode }[] = [
    { title: 'Set up your authenticator', detail: 'About 1 minute' },
    { title: 'Save your recovery codes', detail: 'Required' },
    { title: 'Add a passkey', detail: 'Optional' },
    { title: 'Complete your profile', detail: 'Name and avatar', icon: <UserRound size={11} /> },
  ]
  return (
    <>
      <span className="access-welcome-tile">
        <ServerTile name={server} size="large">
          <span className="access-tile-badge">
            <Check size={11} strokeWidth={3} />
          </span>
        </ServerTile>
      </span>
      <Heading
        title={`You've joined ${server}`}
        description={`${inviter.name} invited you. Before you start, take two minutes to secure your account, so your team's conversations stay private.`}
      />
      <div className="access-person">
        <Avatar avatar={inviter.avatar} name={inviter.name} photo={photo} size={30} />
        <div>
          <strong>{inviter.name} invited you</strong>
          <span>
            {inviter.role === 'admin' ? 'Admin' : 'Member'} · {inviter.email}
          </span>
        </div>
      </div>
      <p className="access-list-title">What's next</p>
      <ol className="access-plan">
        {plan.map((item, index) => (
          <li key={item.title}>
            <i className={index === 0 ? 'is-next' : item.icon ? 'is-dashed' : ''}>
              {item.icon ?? index + 1}
            </i>
            <span>{item.title}</span>
            <span>{item.detail}</span>
          </li>
        ))}
      </ol>
      <Primary type="button" onClick={start}>
        Get started
      </Primary>
    </>
  )
}
function otpAccount(uri: string) {
  try {
    const url = new URL(uri)
    const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const [prefix, ...rest] = label.split(':')
    const issuer = url.searchParams.get('issuer') ?? (rest.length ? prefix : 'Huddle')
    return `${issuer} · ${rest.length ? rest.join(':') : label}`
  } catch {
    return null
  }
}
function Enrollment({
  stage,
  busy,
  working,
  problem,
  verify,
}: {
  stage: Extract<AccessStage, { kind: 'enroll' }>
  busy: boolean
  working: boolean
  problem: Problem | null
  verify: (code: string) => Promise<void>
}) {
  const [qr, setQr] = useState('')
  const [qrError, setQrError] = useState('')
  useEffect(() => {
    let cancelled = false
    setQr('')
    void QRCode.toDataURL(stage.uri, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
      .then((value) => {
        if (!cancelled) setQr(value)
      })
      .catch((failure) => {
        if (!cancelled) setQrError(errorText(failure))
      })
    return () => {
      cancelled = true
    }
  }, [stage.uri])
  const account = otpAccount(stage.uri)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void verify(z.string().parse(new FormData(event.currentTarget).get('code')))
      }}
    >
      <ol className="access-numbered">
        <li>
          <h2>Open an authenticator app</h2>
          <p>Any app with time-based codes works, including most password managers.</p>
        </li>
        <li>
          <h2>Scan this QR code</h2>
          <div className="access-qr-row">
            {qr ? (
              <img
                className="access-qr"
                src={qr}
                alt="Scan this QR code with your authenticator app"
              />
            ) : (
              <div className="access-qr" role="status">
                {qrError || 'Generating QR code…'}
              </div>
            )}
            <div>
              <p>Can't scan? Enter this setup key in the app instead.</p>
              <div className="access-key">
                <code className="access-secret" data-secret={stage.secret}>
                  {stage.secret.match(/.{1,4}/g)?.join(' ')}
                </code>
                <CopyButton value={stage.secret} label="Copy setup key" iconOnly />
              </div>
              {account && <p>Account: {account}</p>}
            </div>
          </div>
        </li>
        <li>
          <h2>Enter the code it shows</h2>
          <CodeField hideLabel invalid={problem?.code === 'invalid'} />
          <ProblemAlert problem={problem} />
        </li>
      </ol>
      {stage.replacing && (
        <Alert
          tone="warning"
          message="Codes from your current authenticator stop working as soon as you confirm."
        />
      )}
      <Primary busy={busy} disabled={working}>
        {stage.replacing ? 'Confirm and replace' : 'Confirm and continue'}
      </Primary>
    </form>
  )
}
function RecoverySave({
  stage,
  busy,
  working,
  acknowledge,
}: {
  stage: Extract<AccessStage, { kind: 'save-recovery' }>
  busy: boolean
  working: boolean
  acknowledge: () => void
}) {
  const [saved, setSaved] = useState(false)
  function download() {
    const url = URL.createObjectURL(
      new Blob([stage.codes.join('\n') + '\n'], { type: 'text/plain' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'huddle-recovery-codes.txt'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <>
      <div className="access-recovery">
        <ol aria-label="Recovery codes">
          {stage.codes.map((code, index) => (
            <li key={code}>
              <span aria-hidden="true">{index + 1}</span>
              <code>{code}</code>
            </li>
          ))}
        </ol>
        <div className="access-recovery-tools">
          <CopyButton value={stage.codes.join('\n')} />
          <button type="button" className="access-tool" onClick={download}>
            <Download size={13} />
            Download .txt
          </button>
        </div>
      </div>
      <label className="access-checkbox">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        <span>
          I've saved these codes
          <small>You won't see them again after continuing.</small>
        </span>
      </label>
      <Primary type="button" busy={busy} disabled={working || !saved} onClick={acknowledge}>
        Continue
      </Primary>
    </>
  )
}

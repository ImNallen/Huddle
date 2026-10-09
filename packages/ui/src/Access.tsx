import { useEffect, useRef, useState, type FormEvent } from 'react'
import { KeyRound, Mail, ShieldCheck, Copy, Download, Monitor, RefreshCw } from 'lucide-react'
import QRCode from 'qrcode'
import { z } from 'zod'
import {
  type AccessCommand,
  type AccessView,
  type AccessStage,
  type Profile,
  type ServerInfo,
} from '@huddle/contracts'
import { Frame, Heading, Alert, Primary, CodeField, Steps, serverInitials } from './primitives'
import { ProfileEditor, Avatar } from './Avatar'
import { RequestError } from './connection'
import { errorText, type Transport } from './transport'
import { addPasskey, signInPasskey } from './passkeys'

export interface AccessAdapter {
  act(command: AccessCommand, signal?: AbortSignal): Promise<AccessView>
  accept(view: AccessView, signal?: AbortSignal): Promise<void>
  company(signal: AbortSignal, setup?: { code: string; serverName: string }): Promise<void>
  browser?(): Promise<void>
  browserSecurity?(): Promise<void>
  upload(file: File): Promise<string>
  photo(id: string, signal: AbortSignal): Promise<string>
}
export function Access({
  client,
  adapter,
  view,
  info,
  notice = '',
  onServer,
  onSignOut,
}: {
  client: Transport
  adapter: AccessAdapter
  view: AccessView
  info: z.infer<typeof ServerInfo>
  notice?: string
  onServer?: () => void
  onSignOut?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryAt, setRetryAt] = useState(0)
  const now = useNow()
  const working = busy || retryAt > now
  const [resetRequested, setResetRequested] = useState(false)
  const [resetForm, setResetForm] = useState(false)
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    lifetime.current = new AbortController()
    return () => lifetime.current.abort()
  }, [client])
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current.signal
    setBusy(true)
    setError('')
    setRetryAt(0)
    try {
      await action(signal)
    } catch (failure) {
      if (!signal.aborted && client.active) {
        setError(
          failure instanceof RequestError && failure.retryAt
            ? `${failure.message} Try again at ${new Date(failure.retryAt).toLocaleTimeString()}.`
            : errorText(failure),
        )
        if (failure instanceof RequestError && failure.retryAt)
          setRetryAt(Date.parse(failure.retryAt))
      }
    } finally {
      if (!signal.aborted && client.active) setBusy(false)
    }
  }
  function act(command: AccessCommand) {
    return run(async (signal) => adapter.accept(await adapter.act(command, signal), signal))
  }
  function submit(event: FormEvent<HTMLFormElement>, command: (form: FormData) => AccessCommand) {
    event.preventDefault()
    void act(command(new FormData(event.currentTarget)))
  }
  const stage = view.stage
  const account =
    stage.kind === 'totp' || stage.kind === 'recovery' || stage.kind === 'ready'
      ? stage.user.email
      : undefined
  const frame = {
    server: { name: info.name, origin: client.origin },
    account,
    onServer,
    onSignOut:
      stage.kind === 'signin' || stage.kind === 'setup' || stage.kind === 'email'
        ? undefined
        : onSignOut,
  }
  const serverCard = (
    <div className="access-card access-row access-signin-server">
      <i className="access-server-tile">{serverInitials(info.name)}</i>
      <div style={{ flex: 1 }}>
        {info.name}
        <p>
          <code>{new URL(client.origin).host}</code>
        </p>
      </div>
      {onServer && (
        <button className="access-link" onClick={onServer}>
          Change server
        </button>
      )}
    </div>
  )
  if (resetForm)
    return (
      <Frame {...frame}>
        <Heading
          title="Request account recovery"
          description="If you have lost your authenticator, passkeys and recovery codes, request help from this server's recovery operator. They must confirm your identity before restoring access."
          back={() => setResetForm(false)}
        />
        {resetRequested ? (
          <div className="access-card" role="status">
            If this account can be recovered, the server operator will review your request. Contact
            your company's support team to confirm your identity.
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const email = z.string().parse(new FormData(event.currentTarget).get('email'))
              void run(async (signal) => {
                await adapter.act({ kind: 'reset.request', email }, signal)
                setResetRequested(true)
              })
            }}
          >
            <label className="access-label">
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                defaultValue={account}
              />
            </label>
            <Alert message={error} />
            <Primary busy={working}>Request a reset</Primary>
          </form>
        )}
      </Frame>
    )
  switch (stage.kind) {
    case 'setup': {
      const email = stage.methods.includes('email')
      const company = stage.methods.includes('company') && !adapter.browser
      return (
        <Frame {...frame}>
          {serverCard}
          <Heading
            title="Set up this server"
            description="This Huddle server is not set up yet. Name it and create the first admin account. Everyone else joins by invitation."
          />
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              const code = z.string().parse(form.get('code')).trim()
              const serverName = z.string().parse(form.get('serverName')).trim()
              const submitter = (event.nativeEvent as SubmitEvent).submitter
              if (submitter?.getAttribute('value') !== 'company')
                return void act({
                  kind: 'setup.start',
                  code,
                  serverName,
                  email: z.string().parse(form.get('email')),
                })
              if (!code || !serverName) return setError('Enter the setup code and a server name.')
              void run((signal) => adapter.company(signal, { code, serverName }))
            }}
          >
            <label className="access-label">
              Setup code
              <input
                name="code"
                required
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX"
              />
            </label>
            <label className="access-label">
              Server name
              <input name="serverName" required maxLength={60} placeholder="e.g. Harbor & Co." />
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
                <Primary busy={working} disabled={!info.emailAvailable}>
                  Continue with email
                </Primary>
                {!info.emailAvailable && (
                  <p className="access-note">
                    Email is not configured on this server. Configure SMTP to set it up.
                  </p>
                )}
              </>
            )}
            {email && company && <div className="access-divider">or</div>}
            {company && (
              <button
                className="access-secondary"
                name="method"
                value="company"
                formNoValidate
                disabled={working}
              >
                <ShieldCheck size={15} />
                Continue with company login
              </button>
            )}
          </form>
          {!email && !company && (
            <p className="access-note">
              This server uses company login. Open <code>{client.origin}/login</code> in a browser
              to finish setup.
            </p>
          )}
          <Alert message={error || notice} />
          <p className="access-footer">
            The setup code is in the server log. It works once and changes each time the server
            restarts.
          </p>
        </Frame>
      )
    }
    case 'signin':
      return (
        <Frame {...frame}>
          {serverCard}
          <Heading
            title={`Sign in to ${info.name}`}
            description="Your account lives on this server."
          />
          {stage.methods.includes('company') && (
            <button
              className="access-secondary"
              disabled={working}
              onClick={() => void run(adapter.company)}
            >
              <ShieldCheck size={15} />
              Continue with company login
            </button>
          )}
          {stage.methods.includes('company') && stage.methods.includes('email') && (
            <div className="access-divider">or</div>
          )}
          {stage.methods.includes('email') && (
            <form
              onSubmit={(event) =>
                submit(event, (form) => ({
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
                />
              </label>
              <Primary busy={working} disabled={!info.emailAvailable}>
                Continue with email
              </Primary>
              {!info.emailAvailable && (
                <p className="access-note">
                  Email sign-in is currently unavailable on this server.
                </p>
              )}
            </form>
          )}
          {stage.methods.includes('passkey') && (
            <button
              className="access-secondary"
              disabled={working}
              onClick={() =>
                void run(async (signal) => {
                  if (adapter.browser) await adapter.browser()
                  else await adapter.accept(await signInPasskey(client, signal), signal)
                })
              }
            >
              <KeyRound size={15} />
              Sign in with a passkey
            </button>
          )}
          {adapter.browser && (
            <button
              className="access-secondary"
              disabled={working}
              onClick={() => void run(() => adapter.browser?.() ?? Promise.resolve())}
            >
              <Monitor size={15} />
              Sign in in your browser
            </button>
          )}
          <Alert message={error || notice} />
          <p className="access-footer">Need access? Ask an admin of this server for an invite.</p>
          {stage.methods.includes('email') && (
            <button className="access-link" onClick={() => setResetForm(true)}>
              Recover your account
            </button>
          )}
        </Frame>
      )
    case 'email':
      return (
        <Frame {...frame}>
          <Heading
            title="Check your email"
            icon={<Mail size={20} />}
            description={
              <>
                We sent a 6-digit code to <strong>{stage.email}</strong> to verify your address.
              </>
            }
            back={onSignOut}
          />
          <p className="access-note">
            <Expiry expiresAt={stage.expiresAt} />
          </p>
          <form
            onSubmit={(event) =>
              submit(event, (form) => ({
                kind: 'email.verify',
                code: z.string().parse(form.get('code')),
              }))
            }
          >
            <CodeField label="Code" />
            <Primary busy={working}>Verify</Primary>
          </form>
          <Alert message={error} />
          <div className="access-inline-buttons access-footer">
            <span>Didn't get it? Check your spam folder.</span>
            <Resend
              resendAt={stage.resendAt}
              busy={working}
              resend={() => void act({ kind: 'email.send', email: stage.email })}
            />
          </div>
        </Frame>
      )
    case 'enroll':
      return (
        <Frame {...frame} wide>
          <Steps step={1} />
          <Heading
            title={stage.replacing ? 'Replace your authenticator' : 'Set up your authenticator'}
            description="Huddle uses a code from an authenticator app each time you sign in with email. This keeps your account safe even if someone gets access to your inbox."
          />
          <Enrollment
            stage={stage}
            busy={working}
            verify={(code) =>
              act({ kind: 'enrollment.verify', generation: stage.generation, code })
            }
            refresh={() => void act({ kind: 'enrollment.refresh' })}
          />
          <Alert message={error} />
        </Frame>
      )
    case 'save-recovery':
      return (
        <Frame {...frame} wide>
          <Steps step={2} />
          <Heading
            title="Save your recovery codes"
            description="If you lose your phone and your authenticator, each of these codes gets you in once. Keep them somewhere only you can access, like your password manager. You won't see them again after continuing."
          />
          <RecoverySave
            stage={stage}
            busy={working}
            acknowledge={() => void act({ kind: 'recovery.ack', batch: stage.batch })}
          />
          <Alert message={error} />
        </Frame>
      )
    case 'passkey-offer':
      return (
        <Frame {...frame}>
          <Steps step={3} />
          <Heading
            title="Add a passkey"
            description="Next time, sign in with your fingerprint, face or device PIN. Your passkey may sync through your device or password manager. It replaces email and authenticator codes at sign-in."
          />
          <button
            className="access-primary"
            disabled={working}
            onClick={() =>
              void run(async (signal) => {
                if (adapter.browserSecurity) await adapter.browserSecurity()
                else await adapter.accept(await addPasskey(client, 'My passkey', signal), signal)
              })
            }
          >
            <KeyRound size={15} />
            Add passkey{adapter.browser && ' in browser'}
          </button>
          <button
            className="access-secondary"
            disabled={working}
            onClick={() => void act({ kind: 'passkey.skip' })}
          >
            Skip for now
          </button>
          <Alert message={error} />
          <p className="access-note">
            {adapter.browser
              ? 'Add a passkey in Account security in the browser, then return here and continue. You can also skip and add one later.'
              : 'You can add passkeys later in Account security.'}
          </p>
        </Frame>
      )
    case 'totp':
      return (
        <Frame {...frame}>
          <Heading
            title="Enter your authenticator code"
            icon={<ShieldCheck size={20} />}
            description="Open your authenticator app and enter the 6-digit code for Huddle."
            back={onSignOut}
          />
          <div className="access-card access-avatar-preview">
            <Avatar
              avatar={stage.user.avatar}
              name={stage.user.name}
              photo={adapter.photo}
              size={30}
            />
            <div>
              {stage.user.name}
              <p>{stage.user.email}</p>
            </div>
          </div>
          <form
            onSubmit={(event) =>
              submit(event, (form) => ({
                kind: 'totp.verify',
                code: z.string().parse(form.get('code')),
              }))
            }
          >
            <CodeField label="Authenticator code" />
            <Primary busy={working}>Verify</Primary>
          </form>
          <Alert message={error} />
          <div className="access-inline-buttons access-footer">
            <button className="access-link" onClick={() => void act({ kind: 'recovery.choose' })}>
              Use a recovery code
            </button>
            <button className="access-link" onClick={() => setResetForm(true)}>
              Cannot sign in?
            </button>
          </div>
        </Frame>
      )
    case 'recovery':
      return (
        <Frame {...frame}>
          <Heading
            title="Recover your account"
            description="Enter one of the recovery codes you saved when you set up Huddle. Each code works once."
            back={onSignOut}
          />
          <form
            onSubmit={(event) =>
              submit(event, (form) => ({
                kind: 'recovery.verify',
                code: z.string().parse(form.get('code')).trim(),
              }))
            }
          >
            <label className="access-label">
              Recovery code
              <input
                name="code"
                required
                maxLength={128}
                autoComplete="off"
                placeholder="xxxxx-xxxxx"
              />
            </label>
            <Primary busy={working}>Recover account</Primary>
          </form>
          <Alert message={error} />
          <div className="access-card">
            <h2>Lost your authenticator, passkeys and recovery codes?</h2>
            <p>
              A server recovery operator must confirm your identity before resetting your account.
              Server admins cannot reset accounts.
            </p>
            <button className="access-link" onClick={() => setResetForm(true)}>
              Request a reset
            </button>
          </div>
        </Frame>
      )
    case 'profile':
      return (
        <Frame {...frame} wide>
          <Heading
            title="Complete your profile"
            description="This is how coworkers will see you in messages, channels and Huddles."
          />
          <ProfileEditor
            initial={stage.profile}
            save={(profile: Profile) => act({ kind: 'profile.save', profile })}
            busy={working}
            upload={adapter.upload}
            photo={adapter.photo}
          />
          <Alert message={error} />
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
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}
function Expiry({ expiresAt }: { expiresAt: string }) {
  const now = useNow()
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
  return (
    <span>
      {seconds
        ? `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        : 'This code expired. Request a new code.'}
    </span>
  )
}
function Resend({
  resendAt,
  busy,
  resend,
}: {
  resendAt: string
  busy: boolean
  resend: () => void
}) {
  const now = useNow()
  const seconds = Math.max(0, Math.ceil((Date.parse(resendAt) - now) / 1000))
  return (
    <button className="access-link" disabled={busy || seconds > 0} onClick={resend}>
      {seconds ? `Resend in ${seconds}s` : 'Resend code'}
    </button>
  )
}
function Enrollment({
  stage,
  busy,
  verify,
  refresh,
}: {
  stage: Extract<AccessStage, { kind: 'enroll' }>
  busy: boolean
  verify: (code: string) => Promise<void>
  refresh: () => void
}) {
  const [qr, setQr] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let cancelled = false
    setQr('')
    setCopied(false)
    void QRCode.toDataURL(stage.uri, { width: 360, margin: 2, errorCorrectionLevel: 'M' })
      .then((value) => {
        if (!cancelled) setQr(value)
      })
      .catch((failure) => {
        if (!cancelled) setError(errorText(failure))
      })
    return () => {
      cancelled = true
    }
  }, [stage.uri])
  async function copy() {
    try {
      await navigator.clipboard.writeText(stage.secret)
      setCopied(true)
    } catch (failure) {
      setError(errorText(failure))
    }
  }
  return (
    <div className="access-enrollment">
      <div>
        {qr ? (
          <img className="access-qr" src={qr} alt="Scan this QR code with your authenticator app" />
        ) : (
          <div className="access-qr" role="status">
            Generating QR code…
          </div>
        )}
        <p className="access-note">Can't scan? Enter this key manually.</p>
        <code className="access-secret">{stage.secret}</code>
        <div className="access-inline-buttons">
          <button className="access-link" onClick={() => void copy()}>
            <Copy size={12} /> {copied ? 'Copied' : 'Copy key'}
          </button>
          <button className="access-link" disabled={busy} onClick={refresh}>
            <RefreshCw size={12} /> New secret
          </button>
        </div>
        <Alert message={error} />
      </div>
      <div>
        <h2>Open an authenticator app</h2>
        <p className="access-note">
          Use an app such as 1Password, Google Authenticator or Microsoft Authenticator.
        </p>
        <h2>Scan the QR code</h2>
        <p className="access-note">Or enter the setup key manually.</p>
        <h2>Enter the code it shows</h2>
        <p className="access-note">This confirms that the app is set up correctly.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void verify(z.string().parse(new FormData(event.currentTarget).get('code')))
          }}
        >
          <CodeField />
          <Primary busy={busy}>Confirm and continue</Primary>
        </form>
      </div>
    </div>
  )
}
function RecoverySave({
  stage,
  busy,
  acknowledge,
}: {
  stage: Extract<AccessStage, { kind: 'save-recovery' }>
  busy: boolean
  acknowledge: () => void
}) {
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setSaved(false)
    setCopied(false)
  }, [stage.batch])
  async function copy() {
    try {
      await navigator.clipboard.writeText(stage.codes.join('\n'))
      setCopied(true)
    } catch (failure) {
      setError(errorText(failure))
    }
  }
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
      <div className="access-card">
        <div className="access-recovery-grid">
          {stage.codes.map((code) => (
            <code key={code}>{code}</code>
          ))}
        </div>
        <div className="access-actions">
          <button className="access-link" onClick={() => void copy()}>
            <Copy size={12} />
            {copied ? 'Copied' : 'Copy all'}
          </button>
          <button className="access-link" onClick={download}>
            <Download size={12} />
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
          I've saved these codes somewhere safe.
          <small className="access-note" style={{ display: 'block', margin: 0 }}>
            They are your backup if you lose your authenticator. Treat them like a password.
          </small>
        </span>
      </label>
      <Primary busy={busy} disabled={!saved} onClick={acknowledge}>
        Continue
      </Primary>
      <Alert message={error} />
    </>
  )
}

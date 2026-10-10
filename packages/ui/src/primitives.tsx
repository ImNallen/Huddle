import { Check, ChevronLeft, CircleAlert, Clock, Copy, Info, TriangleAlert, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { serverInitials } from '@huddle/contracts'

export type FrameServer = { name?: string; origin: string }
export function Frame({
  server,
  account,
  onServer,
  onSignOut,
  onSignIn,
  children,
  wide = false,
}: {
  server?: FrameServer
  account?: string
  onServer?: () => void
  onSignOut?: () => void
  onSignIn?: () => void
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className="access-shell">
      <header className="access-header">
        <nav className="access-crumbs" aria-label="Location">
          <a className="access-brand" href="/">
            <Logo size={20} />
            <span>huddle</span>
          </a>
          {server && (
            <>
              <span className="access-crumb-slash" aria-hidden="true">
                /
              </span>
              <span className="access-crumb" title={hostOf(server.origin)}>
                <ServerTile name={server.name} size="small" />
                {server.name ?? <code>{hostOf(server.origin)}</code>}
              </span>
            </>
          )}
        </nav>
        <div className="access-header-right">
          {account && <span className="access-header-account">{account}</span>}
          {onServer && <button onClick={onServer}>Change server</button>}
          {onSignIn && <button onClick={onSignIn}>Sign in</button>}
          {onSignOut && <button onClick={onSignOut}>Sign out</button>}
        </div>
      </header>
      <main className={`access-main ${wide ? 'access-wide' : ''}`}>{children}</main>
    </div>
  )
}
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <mask id="huddle-logo-cut">
        <rect width="24" height="24" fill="white" />
        <rect x="5.9" width="1.3" height="24" fill="black" />
        <rect x="16.8" width="1.3" height="24" fill="black" />
        <rect x="10.8" width="2.4" height="9.6" fill="black" />
        <rect x="10.8" y="14.4" width="2.4" height="9.6" fill="black" />
      </mask>
      <circle cx="12" cy="12" r="12" fill="currentColor" mask="url(#huddle-logo-cut)" />
    </svg>
  )
}
export function hostOf(origin: string) {
  return new URL(origin).host
}
export function ServerTile({
  name,
  size = 'medium',
  children,
}: {
  name?: string
  size?: 'small' | 'medium' | 'large'
  children?: ReactNode
}) {
  return (
    <i className={`access-server-tile access-server-tile-${size} ${name ? '' : 'is-unknown'}`}>
      {name ? serverInitials(name) : '?'}
      {children}
    </i>
  )
}
export function ServerCard({
  server,
  label,
  onServer,
  serverLabel = 'Change',
}: {
  server: FrameServer
  label?: string
  onServer?: () => void
  serverLabel?: string
}) {
  return (
    <div className="access-server-card">
      <ServerTile name={server.name} />
      <div>
        <strong>{label ?? server.name}</strong>
        <code>{hostOf(server.origin)}</code>
      </div>
      {onServer && (
        <button type="button" className="access-link" onClick={onServer}>
          {serverLabel}
        </button>
      )}
    </div>
  )
}
export function Heading({
  title,
  description,
  icon,
  iconTone,
  eyebrow,
  back,
  backLabel = 'Back',
}: {
  title: string
  description?: ReactNode
  icon?: ReactNode
  iconTone?: 'success' | 'danger'
  eyebrow?: string
  back?: () => void
  backLabel?: string
}) {
  return (
    <>
      {back && (
        <button type="button" className="access-back" onClick={back}>
          <ChevronLeft size={14} />
          {backLabel}
        </button>
      )}
      {icon && <div className={`access-symbol ${iconTone ? `is-${iconTone}` : ''}`}>{icon}</div>}
      {eyebrow && <p className="access-eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {description && <p className="access-description">{description}</p>}
    </>
  )
}
export type Tone = 'danger' | 'warning' | 'info'
const toneIcons = { danger: CircleAlert, warning: TriangleAlert, info: Info }
export function Alert({
  message,
  lead,
  tone = 'danger',
  icon,
}: {
  message?: ReactNode
  lead?: string
  tone?: Tone
  icon?: ReactNode
}) {
  if (!message && !lead) return null
  const Icon = toneIcons[tone]
  return (
    <div className={`access-alert access-alert-${tone}`} role={tone === 'info' ? 'note' : 'alert'}>
      <span className="access-alert-icon">{icon ?? <Icon size={14} />}</span>
      <p>
        {lead && <strong>{lead}</strong>} {message}
      </p>
    </div>
  )
}
export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="access-spinner" style={{ width: size, height: size }} aria-hidden />
}
export function Primary({
  children,
  busy,
  busyLabel,
  disabled,
  onClick,
  type = 'submit',
}: {
  children: ReactNode
  busy?: boolean
  busyLabel?: string
  disabled?: boolean
  onClick?: () => void
  type?: 'submit' | 'button'
}) {
  return (
    <button
      type={type}
      className="access-primary"
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {busy && busyLabel ? (
        <>
          <Spinner />
          {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  )
}
export function Countdown({ until, now }: { until: string | number; now: number }) {
  const seconds = Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000))
  return <>{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</>
}
export function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}
export function CodeField({
  label = '6-digit code',
  name = 'code',
  aside,
  invalid = false,
  expired = false,
  hideLabel = false,
}: {
  label?: string
  name?: string
  aside?: ReactNode
  invalid?: boolean
  expired?: boolean
  hideLabel?: boolean
}) {
  const id = useId()
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const active = focused && !expired ? Math.min(value.length, 5) : -1
  return (
    <div className="access-field">
      <div className={`access-label-row ${hideLabel ? 'access-visually-hidden' : ''}`}>
        <label htmlFor={id}>{label}</label>
        {aside}
      </div>
      <div className={`access-code ${invalid ? 'is-invalid' : ''} ${expired ? 'is-expired' : ''}`}>
        <input
          id={id}
          name={name}
          value={value}
          onChange={(event) => setValue(event.target.value.replace(/\D/g, '').slice(0, 6))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          minLength={6}
          autoComplete="one-time-code"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          disabled={expired}
          required
          autoFocus
        />
        <div className="access-code-boxes" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} className={index === active ? 'is-active' : ''}>
              {value[index] ?? ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
export function Expiry({
  expiresAt,
  now,
  expired = Date.parse(expiresAt) <= now,
}: {
  expiresAt: string
  now: number
  expired?: boolean
}) {
  return (
    <span className={`access-aside ${expired ? 'is-warning' : ''}`}>
      <Clock size={12} />
      {expired ? (
        'Expired'
      ) : (
        <>
          Expires in <Countdown until={expiresAt} now={now} />
        </>
      )}
    </span>
  )
}
const stepLabels = ['Authenticator', 'Recovery codes', 'Passkey']
export function Steps({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="access-steps">
      <div className="access-steps-head">
        <span>Secure your account</span>
        <span>
          Step {step} of 3{step === 3 ? ' · Optional' : ''}
        </span>
      </div>
      <ol>
        {stepLabels.map((label, index) => {
          const state = index + 1 < step ? 'done' : index + 1 === step ? 'current' : 'ahead'
          return (
            <li
              key={label}
              className={`is-${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              {state === 'done' && <Check size={11} />}
              {label}
              {state === 'done' && <span className="access-visually-hidden"> (done)</span>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
export function CopyButton({
  value,
  label = 'Copy',
  iconOnly = false,
}: {
  value: string
  label?: string
  iconOnly?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label
  return (
    <button
      type="button"
      className={`access-tool ${state === 'copied' ? 'is-copied' : ''} ${iconOnly ? 'is-icon' : ''}`}
      onClick={() => void copy()}
      aria-label={iconOnly ? text : undefined}
      title={iconOnly ? text : undefined}
    >
      {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      {!iconOnly && text}
    </button>
  )
}
export function Dialog({
  title,
  children,
  close,
}: {
  title: string
  children: ReactNode
  close: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="access-dialog"
      aria-labelledby="access-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <button className="access-dialog-close" aria-label="Close" onClick={close}>
        <X size={18} />
      </button>
      <h2 id="access-dialog-title">{title}</h2>
      {children}
    </dialog>
  )
}

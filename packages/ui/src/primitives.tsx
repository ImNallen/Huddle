import { Server, ArrowLeft, ArrowRight, X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

export function Frame({
  server,
  account,
  onServer,
  onSignOut,
  children,
  wide = false,
}: {
  server?: { name: string; origin: string }
  account?: string
  onServer?: () => void
  onSignOut?: () => void
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className="access-shell">
      <header className="access-header">
        <a className="access-brand" href="/">
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <rect width="24" height="24" rx="6" fill="#f5f5f5" />
            <circle cx="8" cy="13" r="2" fill="#0a0a0a" />
            <circle cx="13" cy="9" r="2" fill="#0a0a0a" />
            <circle cx="16" cy="14" r="2" fill="#0a0a0a" />
          </svg>
          <span>Huddle</span>
        </a>
        <div className="access-header-right">
          {server && (
            <span className="access-host">
              <Server size={13} />
              {server.name}
              <span>{new URL(server.origin).host}</span>
            </span>
          )}
          {account && <span>{account}</span>}
          {onServer && <button onClick={onServer}>Switch server</button>}
          {onSignOut && <button onClick={onSignOut}>Sign out</button>}
        </div>
      </header>
      <main className={`access-main ${wide ? 'access-wide' : ''}`}>{children}</main>
    </div>
  )
}
export function Heading({
  title,
  description,
  icon,
  back,
}: {
  title: string
  description?: ReactNode
  icon?: ReactNode
  back?: () => void
}) {
  return (
    <>
      <div className="access-back">
        {back && (
          <button onClick={back}>
            <ArrowLeft size={13} />
            Back
          </button>
        )}
      </div>
      {icon && <div className="access-symbol">{icon}</div>}
      <h1>{title}</h1>
      {description && <p className="access-description">{description}</p>}
    </>
  )
}
export function Alert({ message }: { message: string }) {
  return message ? (
    <p className="access-error" role="alert">
      {message}
    </p>
  ) : null
}
export function Primary({
  children,
  busy,
  disabled,
  onClick,
}: {
  children: ReactNode
  busy?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button className="access-primary" disabled={busy || disabled} onClick={onClick}>
      {busy ? 'Please wait…' : children}
      {!busy && <ArrowRight size={15} />}
    </button>
  )
}
export function CodeField({
  label = '6-digit code',
  name = 'code',
}: {
  label?: string
  name?: string
}) {
  return (
    <label className="access-label">
      {label}
      <input
        className="access-code"
        name={name}
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        minLength={6}
        autoComplete="one-time-code"
        placeholder="000000"
        required
        autoFocus
      />
    </label>
  )
}
export function Steps({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="access-steps">
      <div>
        <span>Secure your account</span>
        <span>
          Step {step} of 3{step === 3 ? ' · Optional' : ''}
        </span>
      </div>
      <div className="access-step-track">
        {[1, 2, 3].map((value) => (
          <i key={value} className={value <= step ? 'done' : ''} />
        ))}
      </div>
    </div>
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

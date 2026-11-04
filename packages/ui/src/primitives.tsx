import { Check, ChevronLeft, CircleAlert, Copy, Server } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { serverInitials } from '@huddle/contracts'

export type FrameServer = { name?: string; origin: string }
export function Frame({
  actions,
  footer,
  children,
}: {
  actions?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="access-shell">
      <header className="access-header">
        <a className="access-brand" href="/">
          <Logo size={20} />
          <span>huddle</span>
        </a>
        {actions && <div className="access-header-right">{actions}</div>}
      </header>
      <main className="access-main">{children}</main>
      {footer && <footer className="access-foot">{footer}</footer>}
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
export function ServerTile({ name }: { name?: string }) {
  return (
    <i className={`access-server-tile ${name ? '' : 'is-unknown'}`}>
      {name ? serverInitials(name) : <Server size={16} aria-hidden="true" />}
    </i>
  )
}
export function ServerCard({
  server,
  label,
  onServer,
  serverLabel = 'Change',
  children,
}: {
  server: FrameServer
  label?: string
  onServer?: () => void
  serverLabel?: string
  children?: ReactNode
}) {
  return (
    <div className="access-server-card">
      <ServerTile name={server.name} />
      <div>
        <strong>{label ?? server.name ?? 'Server'}</strong>
        <code>{hostOf(server.origin)}</code>
      </div>
      {onServer && (
        <button type="button" className="access-link" onClick={onServer}>
          {serverLabel}
        </button>
      )}
      {children}
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
      {back && (
        <button type="button" className="access-back" onClick={back}>
          <ChevronLeft size={14} />
          Back
        </button>
      )}
      {icon && <div className="access-symbol">{icon}</div>}
      <h1>{title}</h1>
      {description && <p className="access-description">{description}</p>}
    </>
  )
}
export function Alert({
  message,
  lead,
  icon,
}: {
  message?: ReactNode
  lead?: string
  icon?: ReactNode
}) {
  if (!message && !lead) return null
  return (
    <div className="access-alert" role="alert">
      <span className="access-alert-icon">{icon ?? <CircleAlert size={14} />}</span>
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
export function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
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

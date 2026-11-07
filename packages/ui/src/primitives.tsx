/// <reference path="./assets.d.ts" />
import { Check, ChevronLeft, CircleAlert, Copy, Server } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { serverInitials } from '@huddle/contracts'
import huddleSymbol from './assets/huddle-symbol.svg'

export type FrameServer = { name?: string; origin: string }
export function Frame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`access-shell ${className}`}>
      <header className="access-header">
        <a className="access-brand" href="/">
          <Logo size={36} />
          <span>huddle</span>
        </a>
      </header>
      <main className="access-main">{children}</main>
    </div>
  )
}
function outside(event: { currentTarget: Element; clientX: number; clientY: number }) {
  const box = event.currentTarget.getBoundingClientRect()
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
}
export function Overlay({
  className,
  labelledBy,
  onClose,
  dismissOnBackdrop = true,
  children,
}: {
  className: string
  labelledBy: string
  onClose: () => void
  dismissOnBackdrop?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const pressedBackdrop = useRef(false)
  useLayoutEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        // A file input's cancel event bubbles here when someone dismisses the file picker.
        if (event.target === event.currentTarget) onClose()
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = outside(event)
      }}
      onClick={(event) => {
        // A drag across the dialog's edge and a click on its padding also target the dialog.
        if (
          dismissOnBackdrop &&
          pressedBackdrop.current &&
          event.target === event.currentTarget &&
          outside(event)
        )
          onClose()
      }}
    >
      {children}
    </dialog>
  )
}
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span
      className="huddle-logo"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        maskImage: `url("${huddleSymbol}")`,
      }}
    />
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
}: {
  server: FrameServer
  label?: string
  onServer?: () => void
  serverLabel?: string
}) {
  return (
    <div className="access-server-card">
      <Logo size={28} />
      <div>
        <strong>{label ?? server.name ?? 'Server'}</strong>
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
  back,
  label,
}: {
  title: string
  label?: string
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
      <div className="access-introduction">
        {icon && <div className="access-symbol">{icon}</div>}
        <h1 aria-label={label}>{title}</h1>
        {description && <p className="access-description">{description}</p>}
      </div>
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
  value: string | (() => string)
  label?: string
  iconOnly?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof value === 'function' ? value() : value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label
  const icon =
    state === 'copied' ? <Check size={iconOnly ? 15 : 13} /> : <Copy size={iconOnly ? 15 : 13} />
  if (iconOnly) {
    return (
      <button
        type="button"
        className={`icon-button ${state === 'copied' ? 'is-copied' : ''}`}
        aria-label={label}
        title={text}
        onClick={() => void copy()}
      >
        {icon}
      </button>
    )
  }
  return (
    <button
      type="button"
      className={`access-tool ${state === 'copied' ? 'is-copied' : ''}`}
      onClick={() => void copy()}
    >
      {icon}
      {text}
    </button>
  )
}

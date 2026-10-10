import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useEffect, useState } from 'react'
import { Logo } from '@huddle/ui'
import { version } from '../../package.json'
import { serverName, setupRequired } from '../lib/admission'
import { config } from '../lib/config'
import { serverInitials } from '@huddle/contracts'

const landing = createServerFn({ method: 'GET' }).handler(async () => ({
  name: await serverName(),
  setupRequired: await setupRequired(),
  origin: config.SERVER_URL,
  version,
}))
export const Route = createFileRoute('/')({ loader: () => landing(), component: Home })

function Home() {
  const { name, setupRequired, origin, version } = Route.useLoaderData()
  return (
    <div className="landing">
      <header className="landing-bar">
        <span className="landing-crumbs">
          <span className="landing-wordmark">
            <Logo size={20} />
            huddle
          </span>
          {!setupRequired && (
            <>
              <span className="landing-slash">/</span>
              <i className="landing-tile">{serverInitials(name)}</i>
              {name}
            </>
          )}
        </span>
        <a href="/login">Sign in</a>
      </header>
      <main className="landing-main">
        <div className="landing-column">
          <Logo size={44} />
          <p className="landing-eyebrow">YOUR TEAM. YOUR SERVER.</p>
          <h1>A place to work together.</h1>
          {setupRequired ? (
            <p className="landing-lede">
              This Huddle server isn't set up yet. If you're the admin, select Set up this server
              and enter the setup code from the server log.
            </p>
          ) : (
            <p className="landing-lede">
              This is the Huddle server for {name.endsWith('.') ? name : `${name}.`} Sign in here in
              your browser, or point the Huddle desktop app at this address to connect.
            </p>
          )}
          <Address origin={origin} />
          <div className="landing-actions">
            <a className="landing-primary" href="/login">
              {setupRequired ? 'Set up this server' : 'Sign in to your account'}
            </a>
            {!setupRequired && (
              <a className="landing-secondary" href="/device">
                <MonitorIcon />
                Authorize a desktop
              </a>
            )}
          </div>
          {!setupRequired && (
            <p className="landing-note">New here? Ask an admin of this server for an invite.</p>
          )}
        </div>
      </main>
      <footer className="landing-bar">
        <span className="landing-status">
          <a href="/api/health">
            <i className="landing-dot" />
            Server health
          </a>
          <code>huddle {version}</code>
        </span>
        {!setupRequired && <span>Run by {name}</span>}
      </footer>
    </div>
  )
}

function Address({ origin }: { origin: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="landing-address">
      <code>{new URL(origin).host}</code>
      <button
        type="button"
        aria-label={copied ? 'Copied server address' : 'Copy server address'}
        title={copied ? 'Copied' : 'Copy server address'}
        onClick={() => void navigator.clipboard.writeText(origin).then(() => setCopied(true))}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
}

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const
function CopyIcon() {
  return (
    <svg {...iconProps}>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg {...iconProps}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
function MonitorIcon() {
  return (
    <svg {...iconProps}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

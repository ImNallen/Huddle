import { Clock, ExternalLink, Monitor } from 'lucide-react'
import { Alert, Frame, Heading, Spinner, hostOf } from './primitives'

export type BrowserWaitState =
  | { kind: 'starting' }
  | { kind: 'waiting'; code: string; expiresAt: number }
  | { kind: 'expired'; code: string }
  | { kind: 'failed'; code?: string; lostContact: boolean; message: string }
export function BrowserWait({
  server,
  state,
  open,
  restart,
  cancel,
  onServer,
}: {
  server: { name: string; origin: string }
  state: BrowserWaitState
  open: () => void
  restart: () => void
  cancel: () => void
  onServer?: () => void
}) {
  const host = hostOf(server.origin)
  const code = state.kind === 'starting' ? undefined : state.code
  return (
    <Frame server={server} onServer={onServer}>
      <Heading
        title="Sign in in your browser"
        icon={<Monitor size={16} />}
        description={
          <>
            Huddle opened <code>{host}/device</code> in your browser. Sign in there and approve this
            desktop.
          </>
        }
      />
      {state.kind === 'waiting' && (
        <button type="button" className="access-secondary" onClick={open}>
          <ExternalLink size={14} />
          Open browser to sign in
        </button>
      )}
      {code && (
        <>
          <p className="access-wait-label">Match this code in your browser</p>
          <div
            className={`access-wait-code ${state.kind === 'waiting' ? '' : 'is-dim'} ${state.kind === 'expired' ? 'is-struck' : ''}`}
          >
            <span>{code.slice(0, 4)}</span>
            <i aria-hidden="true">–</i>
            <span>{code.slice(4)}</span>
          </div>
        </>
      )}
      {state.kind === 'starting' && (
        <p className="access-status" role="status">
          <Spinner />
          Opening your browser…
        </p>
      )}
      {state.kind === 'waiting' && (
        <p className="access-status" role="status">
          <Spinner />
          Waiting for your approval. Expires at{' '}
          {new Date(state.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          .
        </p>
      )}
      {state.kind === 'expired' && (
        <Alert
          tone="warning"
          icon={<Clock size={14} />}
          lead="This code has expired."
          message="Codes last 10 minutes. Start again to get a new one."
        />
      )}
      {state.kind === 'failed' &&
        (state.lostContact ? (
          <Alert
            lead="Sign-in couldn't be completed."
            message={`Huddle lost contact with ${host}. Check your connection and try again.`}
          />
        ) : (
          <Alert lead="Sign-in couldn't be completed." message={state.message} />
        ))}
      {(state.kind === 'expired' || state.kind === 'failed') && (
        <button type="button" className="access-primary" onClick={restart}>
          {state.kind === 'expired' ? 'Start again' : 'Try again'}
        </button>
      )}
      <p className="access-footer is-center">
        <button type="button" className="access-link is-quiet" onClick={cancel}>
          Cancel sign-in
        </button>
      </p>
    </Frame>
  )
}

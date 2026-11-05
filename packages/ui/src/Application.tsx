import { useCallback, useEffect, useState } from 'react'
import type { z } from 'zod'
import { type AccessView as View, type ServerInfo, type Session } from '@huddle/contracts'
import { Access } from './Access'
import { ServerView } from './ServerView'
import { Security } from './Security'
import { WifiOff } from 'lucide-react'
import { Frame, Alert, Heading, ServerCard, Spinner, hostOf } from './primitives'
import { NetworkError, type Connection } from './connection'
import { errorText } from './transport'

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'loaded'; view: View; info: z.infer<typeof ServerInfo> }
export function Application({
  client,
  serverName,
  onServer,
}: {
  client: Connection
  serverName?: string
  onServer?: () => void
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [security, setSecurity] = useState(false)
  const [reload, setReload] = useState(0)
  const accept = useCallback(
    async (incoming: View, signal?: AbortSignal) => {
      if (!client.active || signal?.aborted) return
      client.receive(incoming, signal)
      let view = incoming
      if (incoming.stage.kind === 'ready') {
        view = await client.resume(signal)
        if (!client.active || signal?.aborted) return
        if (view.stage.kind === 'ready' && client.token) await client.remember(client.token, signal)
      }
      if (!client.active || signal?.aborted) return
      setState((current) => (current.kind === 'loaded' ? { ...current, view } : current))
    },
    [client],
  )
  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    void (async () => {
      await client.restore()
      const [view, info] = await Promise.all([client.resume(abort.signal), client.info()])
      if (abort.signal.aborted || !client.active) return
      if (view.stage.kind === 'ready' && client.token)
        await client.remember(client.token, abort.signal)
      if (!abort.signal.aborted && client.active) setState({ kind: 'loaded', view, info })
    })().catch((error: unknown) => {
      if (!abort.signal.aborted && client.active) setState({ kind: 'failed', error })
    })
    return () => abort.abort()
  }, [client, reload])
  async function signOut() {
    try {
      await client.signOut()
      if (!client.active) return
      setSecurity(false)
      const [view, info] = await Promise.all([client.resume(), client.info()])
      if (client.active) setState({ kind: 'loaded', view, info })
    } catch (error) {
      if (client.active) setState({ kind: 'failed', error })
    }
  }
  const hint = serverName ? { name: serverName, origin: client.origin } : undefined
  if (state.kind === 'loading')
    return <Connecting origin={client.origin} server={hint} onServer={onServer} />
  if (state.kind === 'failed')
    return (
      <Frame>
        {onServer && <ServerCard server={hint ?? { origin: client.origin }} onServer={onServer} />}
        <Heading
          title="Could not connect"
          icon={<WifiOff size={16} />}
          description="Huddle couldn't reach your server."
        />
        {state.error instanceof NetworkError ? (
          <Alert
            lead={`${state.error.host} didn't respond.`}
            message="Check that this computer can reach the host, then try again."
          />
        ) : (
          <Alert message={errorText(state.error)} />
        )}
        <button className="access-primary" onClick={() => setReload((value) => value + 1)}>
          Try again
        </button>
        <button className="access-secondary" onClick={() => void signOut()}>
          Start sign-in again
        </button>
      </Frame>
    )
  if (state.view.stage.kind !== 'ready')
    return (
      <Access
        key={state.view.stage.kind}
        client={client}
        act={async (command, signal) => accept(await client.act(command, signal), signal)}
        view={state.view}
        info={state.info}
        onServer={onServer}
      />
    )
  const session: Session = { user: state.view.stage.user }
  return (
    <>
      <ServerView
        client={client}
        session={session}
        onLogout={() => void signOut()}
        onServer={onServer}
        onSecurity={() => setSecurity(true)}
      />
      {security && (
        <Security
          client={client}
          accept={accept}
          close={() => setSecurity(false)}
          signOut={() => void signOut()}
        />
      )}
    </>
  )
}
export function Connecting({
  origin,
  server,
  onServer,
}: {
  origin?: string
  server?: { name: string; origin: string }
  onServer?: () => void
}) {
  const target = server ?? (origin ? { origin } : undefined)
  return (
    <Frame>
      {onServer && target && <ServerCard server={target} onServer={onServer} />}
      <div className="access-connecting" role="status">
        <div className="access-symbol">
          <Spinner size={16} />
        </div>
        <h1>Connecting…</h1>
        {origin && (
          <p>
            Signing you in to <code>{hostOf(origin)}</code>
          </p>
        )}
      </div>
    </Frame>
  )
}

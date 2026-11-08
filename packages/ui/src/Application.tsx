import { useCallback, useEffect, useState } from 'react'
import type { z } from 'zod'
import type { AccessStage, ServerInfo } from '@huddle/contracts'
import { Access } from './Access'
import { ServerView } from './ServerView'
import { Settings } from './Settings'
import { OnboardingProfile } from './OnboardingProfile'
import { WifiOff } from 'lucide-react'
import { Frame, Alert, Heading, ServerCard, Spinner, hostOf } from './primitives'
import { NetworkError, type Connection } from './connection'
import { clearJoinCode } from './joinCode'
import { errorText } from './transport'

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'loaded'; stage: AccessStage; info: z.infer<typeof ServerInfo> }
  | {
      kind: 'personalize'
      stage: Extract<AccessStage, { kind: 'ready' }>
      info: z.infer<typeof ServerInfo>
    }
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
  const [reload, setReload] = useState(0)
  const accept = useCallback(
    (stage: AccessStage, signal?: AbortSignal) => {
      if (!client.active || signal?.aborted) return
      setState((current) => (current.kind === 'loaded' ? { ...current, stage } : current))
    },
    [client],
  )
  const recheck = useCallback(async () => {
    const [stage, info] = await Promise.all([client.stage(), client.info()])
    if (!client.active) return
    client.settle(stage)
    setState({ kind: 'loaded', stage, info })
  }, [client])
  const onAccessChanged = useCallback(() => {
    void recheck().catch(() => undefined)
  }, [recheck])
  useEffect(() => {
    const abort = new AbortController()
    setState({ kind: 'loading' })
    void Promise.all([client.stage(abort.signal), client.info()]).then(
      ([stage, info]) => {
        if (abort.signal.aborted || !client.active) return
        client.settle(stage)
        setState({ kind: 'loaded', stage, info })
      },
      (error: unknown) => {
        if (!abort.signal.aborted && client.active) setState({ kind: 'failed', error })
      },
    )
    return () => abort.abort()
  }, [client, reload])
  useEffect(() => {
    client.onAccessChanged = onAccessChanged
    return () => {
      client.onAccessChanged = null
    }
  }, [client, onAccessChanged])
  const ready =
    state.kind === 'personalize' || (state.kind === 'loaded' && state.stage.kind === 'ready')
  useEffect(() => {
    if (ready) clearJoinCode(client.origin)
  }, [client, ready])
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
            message="Check that Tailscale is connected on this computer, then try again."
          />
        ) : (
          <Alert message={errorText(state.error)} />
        )}
        <button className="access-primary" onClick={() => setReload((value) => value + 1)}>
          Try again
        </button>
      </Frame>
    )
  if (state.kind === 'personalize')
    return (
      <OnboardingProfile
        key={state.stage.user.id}
        client={client}
        stage={state.stage}
        serverName={state.info.name}
        onDone={(stage) => setState({ kind: 'loaded', stage, info: state.info })}
        onAccessChanged={(stage) => setState({ kind: 'loaded', stage, info: state.info })}
      />
    )
  if (state.stage.kind !== 'ready')
    return (
      <Access
        key={state.stage.kind}
        client={client}
        act={async (command, signal) => {
          const next = await client.act(command, signal)
          if (!client.active || signal.aborted) return
          if (
            next.kind === 'ready' &&
            (command.kind === 'account.setup' || command.kind === 'account.join')
          ) {
            const info =
              command.kind === 'account.setup'
                ? { ...state.info, name: command.serverName.trim(), setup: 'complete' as const }
                : state.info
            setState({ kind: 'personalize', stage: next, info })
          } else accept(next, signal)
        }}
        recheck={recheck}
        stage={state.stage}
        info={state.info}
        onServer={onServer}
      />
    )
  return (
    <ReadyView
      key={state.stage.user.id}
      client={client}
      stage={state.stage}
      serverName={state.info.name}
      voiceAvailable={state.info.voice}
      accept={accept}
      onAccessChanged={onAccessChanged}
      onServer={onServer}
    />
  )
}
function ReadyView({
  client,
  stage,
  serverName,
  voiceAvailable,
  accept,
  onAccessChanged,
  onServer,
}: {
  client: Connection
  stage: Extract<AccessStage, { kind: 'ready' }>
  serverName: string
  voiceAvailable: boolean
  accept: (stage: AccessStage) => void
  onAccessChanged: () => void
  onServer?: () => void
}) {
  const [settings, setSettings] = useState<string | null>(null)
  return (
    <>
      <ServerView
        client={client}
        me={{ user: stage.user }}
        covered={settings !== null}
        voiceAvailable={voiceAvailable}
        onAccessChanged={onAccessChanged}
        onServer={onServer}
        onSettings={(name) => setSettings(name ?? serverName)}
      />
      {settings !== null && (
        <Settings
          client={client}
          serverName={settings}
          accept={accept}
          close={() => setSettings(null)}
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
            Reaching <code>{hostOf(origin)}</code>
          </p>
        )}
      </div>
    </Frame>
  )
}

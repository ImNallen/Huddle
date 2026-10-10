import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  type AccessView as View,
  type PublicUser,
  type ServerInfo,
  type Session,
} from '@huddle/contracts'
import { Access, type AccessAdapter } from './Access'
import { ServerView } from './ServerView'
import { Security } from './Security'
import { WifiOff } from 'lucide-react'
import { Frame, Alert, Heading, Spinner, hostOf } from './primitives'
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
  browser,
  openBrowser,
  onReady,
  returnTo,
}: {
  client: Connection
  serverName?: string
  onServer?: () => void
  browser?: () => Promise<void>
  openBrowser?: (url: string) => Promise<void>
  onReady?: (user: PublicUser) => void
  returnTo?: string
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [email, setEmail] = useState<string>()
  const browserSecurity =
    openBrowser && (() => openBrowser(`${client.origin}/login?settings=security`))
  const [security, setSecurity] = useState(false)
  const [reload, setReload] = useState(0)
  const [notice, setNotice] = useState('')
  const resetCapability = useRef<string | null>(null)
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
    if (typeof window !== 'undefined') {
      const location = new URL(window.location.href)
      const capability = location.searchParams.get('reset')
      const failure = location.searchParams.get('error')
      if (capability) resetCapability.current = capability
      if (failure)
        setNotice(
          location.searchParams.get('error_description') ??
            'Company sign-in did not complete. Try again, or ask an admin of this server for help.',
        )
      if (capability || failure) {
        for (const key of ['reset', 'error', 'error_description']) location.searchParams.delete(key)
        window.history.replaceState(null, '', location.pathname + location.search + location.hash)
      }
    }
    void (async () => {
      await client.restore()
      const [view, info] = await Promise.all([client.resume(abort.signal), client.info()])
      if (abort.signal.aborted || !client.active) return
      if (view.stage.kind === 'ready' && client.token)
        await client.remember(client.token, abort.signal)
      if (!abort.signal.aborted && client.active) setState({ kind: 'loaded', view, info })
      const capability = resetCapability.current
      if (capability) {
        const next = await client.act({ kind: 'reset.redeem', capability }, abort.signal)
        if (!abort.signal.aborted && client.active) setState({ kind: 'loaded', view: next, info })
        if (!abort.signal.aborted) resetCapability.current = null
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted && client.active) setState({ kind: 'failed', error })
    })
    return () => abort.abort()
  }, [client, reload])
  async function signOut() {
    resetCapability.current = null
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
  const adapter: AccessAdapter = {
    act: (command, signal) => {
      setNotice('')
      return client.act(command, signal)
    },
    accept,
    company: async (signal, setup) => {
      setNotice('')
      if (browser) return browser()
      const target = new URLSearchParams(window.location.search).get('redirect')
      const callbackURL = returnTo ?? (target?.startsWith('/device?') ? target : '/login')
      const result = await client.request(
        '/api/auth/sign-in/oauth2',
        z.object({ url: z.url() }),
        { providerId: 'company', callbackURL, ...(setup && { purpose: 'setup', ...setup }) },
        signal,
      )
      if (!signal.aborted && client.active) window.location.assign(result.url)
    },
    browser,
    openBrowser,
    upload: (file) => client.upload(file),
    photo: (id, signal) => client.photo(id, signal),
  }
  useEffect(() => {
    if (state.kind !== 'loaded' || state.view.stage.kind !== 'ready' || browser) return
    const target = new URLSearchParams(window.location.search).get('redirect')
    if (target?.startsWith('/device?') && !target.startsWith('//')) window.location.assign(target)
  }, [state, browser])
  useEffect(() => {
    if (state.kind === 'loaded' && state.view.stage.kind === 'ready')
      onReady?.(state.view.stage.user)
  }, [state, onReady])
  const stage = state.kind === 'loaded' ? state.view.stage : null
  useEffect(() => {
    if (!stage) return
    const known = stage.kind === 'email' ? stage.email : 'user' in stage ? stage.user.email : null
    if (known) return setEmail(known)
    if (stage.kind === 'signin' || stage.kind === 'setup') return setEmail(undefined)
    const abort = new AbortController()
    void client
      .session(abort.signal)
      .then((session) => {
        if (session && !abort.signal.aborted) setEmail(session.user.email)
      })
      .catch(() => undefined)
    return () => abort.abort()
  }, [stage, client])
  useEffect(() => {
    if (
      !browser &&
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('settings') === 'security'
    )
      setSecurity(true)
  }, [browser])
  const hint = serverName ? { name: serverName, origin: client.origin } : undefined
  if (state.kind === 'loading')
    return <Connecting origin={client.origin} server={hint} onServer={onServer} />
  if (state.kind === 'failed')
    return (
      <Frame server={hint} onServer={onServer}>
        <Heading
          title="Could not connect"
          icon={<WifiOff size={16} />}
          description="Huddle couldn't reach your server."
        />
        {state.error instanceof NetworkError ? (
          <Alert
            lead={`${state.error.host} didn't respond.`}
            message="Check your connection or VPN, then try again."
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
        key={
          state.view.stage.kind === 'save-recovery' ? state.view.stage.batch : state.view.stage.kind
        }
        client={client}
        adapter={adapter}
        view={state.view}
        info={state.info}
        account={email}
        notice={notice}
        onServer={onServer}
        onSignOut={() => void signOut()}
        fromSecurity={security}
      />
    )
  if (onReady) return <Connecting origin={client.origin} title="Returning to your request…" />
  if (security)
    return (
      <Security
        client={client}
        accept={accept}
        close={() => setSecurity(false)}
        signOut={() => void signOut()}
        browser={browserSecurity}
      />
    )
  const session: Session = { user: state.view.stage.user }
  return (
    <ServerView
      client={client}
      session={session}
      onLogout={() => void signOut()}
      onServer={onServer}
      onSecurity={() => setSecurity(true)}
    />
  )
}
export function Connecting({
  origin,
  server,
  onServer,
  title = 'Connecting…',
}: {
  origin?: string
  server?: { name: string; origin: string }
  onServer?: () => void
  title?: string
}) {
  return (
    <Frame server={server} onServer={onServer}>
      <div className="access-connecting" role="status">
        <div className="access-symbol">
          <Spinner size={16} />
        </div>
        <h1>{title}</h1>
        {origin && (
          <p>
            Signing you in to <code>{hostOf(origin)}</code>
          </p>
        )}
      </div>
    </Frame>
  )
}

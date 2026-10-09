import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  type AccessView as View,
  type PublicUser,
  type ServerInfo,
  type Session,
} from '@huddle/contracts'
import { Access, type AccessAdapter } from './Access'
import { Chat } from './Chat'
import { Security } from './Security'
import { Frame, Alert, Heading } from './primitives'
import type { Connection } from './connection'
import { errorText } from './transport'

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; view: View; info: z.infer<typeof ServerInfo> }
export function Application({
  client,
  onServer,
  browser,
  browserSecurity,
  onReady,
  returnTo,
}: {
  client: Connection
  onServer?: () => void
  browser?: () => Promise<void>
  browserSecurity?: () => Promise<void>
  onReady?: (user: PublicUser) => void
  returnTo?: string
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [security, setSecurity] = useState(false)
  const [reload, setReload] = useState(0)
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
      if (capability) {
        resetCapability.current = capability
        location.searchParams.delete('reset')
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
    })().catch((failure) => {
      if (!abort.signal.aborted && client.active)
        setState({ kind: 'failed', message: errorText(failure) })
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
    } catch (failure) {
      if (client.active) setState({ kind: 'failed', message: errorText(failure) })
    }
  }
  const adapter: AccessAdapter = {
    act: (command, signal) => client.act(command, signal),
    accept,
    company: async (signal) => {
      if (browser) return browser()
      const target = new URLSearchParams(window.location.search).get('redirect')
      const callbackURL = returnTo ?? (target?.startsWith('/device?') ? target : '/login')
      const result = await client.request(
        '/api/auth/sign-in/oauth2',
        z.object({ url: z.url() }),
        { providerId: 'company', callbackURL },
        signal,
      )
      if (!signal.aborted && client.active) window.location.assign(result.url)
    },
    browser,
    browserSecurity,
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
  useEffect(() => {
    if (
      !browser &&
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('settings') === 'security'
    )
      setSecurity(true)
  }, [browser])
  if (state.kind === 'loading')
    return (
      <Frame onServer={onServer}>
        <p role="status">Connecting to your server…</p>
      </Frame>
    )
  if (state.kind === 'failed')
    return (
      <Frame onServer={onServer}>
        <Heading title="Could not connect" />
        <Alert message={state.message} />
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
        onServer={onServer}
        onSignOut={() => void signOut()}
      />
    )
  if (onReady)
    return (
      <Frame>
        <p role="status">Returning to your request…</p>
      </Frame>
    )
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
    <Chat
      client={client}
      session={session}
      onLogout={() => void signOut()}
      onServer={onServer}
      onSecurity={() => setSecurity(true)}
    />
  )
}

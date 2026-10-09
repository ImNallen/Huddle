import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { DeviceCode, DeviceToken } from '@huddle/contracts'
import { Application, BrowserWait, Connect, Connection, saveServer } from '@huddle/ui'
import { Client, RequestError, errorText, openBrowser } from './client'

type Device =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; code: z.infer<typeof DeviceCode>; expiresAt: number; name: string }
  | { kind: 'failed'; message: string }
export function App() {
  const [client, setClient] = useState(
    () => new Client(localStorage.getItem('huddle.server') ?? 'http://localhost:3000'),
  )
  const [editingServer, setEditingServer] = useState(() => !localStorage.getItem('huddle.server'))
  const [device, setDevice] = useState<Device>({ kind: 'idle' })
  const [reload, setReload] = useState(0)
  const deviceLifetime = useRef(new AbortController())
  const deviceCode = useRef<string | null>(null)
  useEffect(
    () => () => {
      deviceLifetime.current.abort()
    },
    [client],
  )
  async function changeServer(origin: string) {
    const next = new Client(origin)
    try {
      const info = await next.info()
      deviceLifetime.current.abort()
      const pendingCode = deviceCode.current
      deviceCode.current = null
      client.disconnect()
      if (pendingCode) {
        const cleanup = new Connection(client.origin, true)
        try {
          await cleanup.request('/api/auth/device/cancel', z.object({ success: z.literal(true) }), {
            device_code: pendingCode,
            client_id: 'huddle-desktop',
          })
        } finally {
          cleanup.disconnect()
        }
      }
      await client.forget()
      saveServer({ origin: next.origin, name: info.name })
      setClient(next)
      setEditingServer(false)
      setDevice({ kind: 'idle' })
    } catch (failure) {
      next.disconnect()
      if (!client.active) {
        setClient(new Client(client.origin))
        setDevice({ kind: 'idle' })
      }
      throw failure
    }
  }
  async function cancel() {
    deviceLifetime.current.abort()
    if (deviceCode.current && client.active) {
      try {
        await client.request('/api/auth/device/cancel', z.object({ success: z.literal(true) }), {
          device_code: deviceCode.current,
          client_id: 'huddle-desktop',
        })
      } catch (failure) {
        setDevice({ kind: 'failed', message: errorText(failure) })
        return
      }
    }
    deviceCode.current = null
    setDevice({ kind: 'idle' })
    setReload((value) => value + 1)
  }
  const browser = useCallback(async () => {
    deviceLifetime.current.abort()
    const abort = new AbortController()
    deviceLifetime.current = abort
    setDevice({ kind: 'starting' })
    try {
      if (deviceCode.current) {
        await client.request(
          '/api/auth/device/cancel',
          z.object({ success: z.literal(true) }),
          { device_code: deviceCode.current, client_id: 'huddle-desktop' },
          abort.signal,
        )
        deviceCode.current = null
      }
      const [code, info] = await Promise.all([
        client.request(
          '/api/auth/device/code',
          DeviceCode,
          { client_id: 'huddle-desktop' },
          abort.signal,
        ),
        client.info(),
      ])
      if (abort.signal.aborted || !client.active) return
      deviceCode.current = code.device_code
      setDevice({
        kind: 'waiting',
        code,
        expiresAt: Date.now() + code.expires_in * 1000,
        name: info.name,
      })
      await openBrowser(code.verification_uri_complete ?? code.verification_uri)
    } catch (failure) {
      if (!abort.signal.aborted && client.active)
        setDevice({ kind: 'failed', message: errorText(failure) })
    }
  }, [client])
  useEffect(() => {
    if (device.kind !== 'waiting') return
    const abort = deviceLifetime.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval = device.code.interval * 1000
    async function poll() {
      if (stopped || abort.signal.aborted || !client.active || device.kind !== 'waiting') return
      if (Date.now() >= device.expiresAt) {
        setDevice({ kind: 'failed', message: 'This code expired. Start again to get a new code.' })
        return
      }
      try {
        const result = await client.request(
          '/api/auth/device/token',
          DeviceToken,
          {
            client_id: 'huddle-desktop',
            device_code: device.code.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          },
          abort.signal,
        )
        if (stopped || abort.signal.aborted || !client.active) return
        const candidate = new Connection(client.origin, true)
        candidate.token = result.access_token
        let view
        try {
          view = await candidate.resume(abort.signal)
        } finally {
          candidate.disconnect()
        }
        if (view.stage.kind !== 'ready')
          throw new Error(
            'This device has not completed sign-in. Finish signing in in your browser.',
          )
        if (stopped || abort.signal.aborted || !client.active) return
        await client.remember(result.access_token, abort.signal)
        if (!stopped && !abort.signal.aborted && client.active) {
          deviceCode.current = null
          setDevice({ kind: 'idle' })
          setReload((value) => value + 1)
        }
      } catch (failure) {
        if (stopped || abort.signal.aborted || !client.active) return
        if (
          failure instanceof RequestError &&
          ['authorization_pending', 'slow_down'].includes(failure.message)
        ) {
          if (failure.message === 'slow_down') interval += 5000
          timer = setTimeout(() => void poll(), interval)
        } else setDevice({ kind: 'failed', message: errorText(failure) })
      }
    }
    timer = setTimeout(() => void poll(), interval)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [client, device])
  if (editingServer)
    return (
      <Connect
        initialOrigin={client.origin}
        connect={changeServer}
        close={localStorage.getItem('huddle.server') ? () => setEditingServer(false) : undefined}
      />
    )
  if (device.kind === 'waiting')
    return (
      <BrowserWait
        server={{ name: device.name, origin: client.origin }}
        code={device.code.user_code}
        expiresAt={device.expiresAt}
        error=""
        open={() =>
          void openBrowser(
            device.code.verification_uri_complete ?? device.code.verification_uri,
          ).catch((failure) => setDevice({ kind: 'failed', message: errorText(failure) }))
        }
        cancel={() => void cancel()}
      />
    )
  if (device.kind === 'starting' || device.kind === 'failed')
    return (
      <div className="access-shell">
        <main className="access-main">
          <h1>
            {device.kind === 'starting' ? 'Opening your browser…' : 'Browser sign-in stopped'}
          </h1>
          {device.kind === 'failed' && (
            <p className="access-error" role="alert">
              {device.message}
            </p>
          )}
          <button className="access-primary" onClick={() => void browser()}>
            Try browser sign-in again
          </button>
          <button className="access-secondary" onClick={() => void cancel()}>
            Cancel
          </button>
        </main>
      </div>
    )
  return (
    <Application
      key={`${client.origin}:${reload}`}
      client={client}
      onServer={() => setEditingServer(true)}
      browser={browser}
      browserSecurity={() => openBrowser(client.origin + '/login?settings=security')}
    />
  )
}

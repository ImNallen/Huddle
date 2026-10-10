import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { DeviceCode, DeviceToken } from '@huddle/contracts'
import {
  Application,
  BrowserWait,
  Connect,
  Connection,
  NetworkError,
  readSavedServers,
  saveServer,
} from '@huddle/ui'
import { Client, RequestError, errorText, focusWindow, openBrowser } from './client'

type Device =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | {
      kind: 'waiting'
      code: string
      grant: z.infer<typeof DeviceCode>
      expiresAt: number
      name: string
    }
  | { kind: 'expired'; code: string; name: string }
  | { kind: 'failed'; code?: string; name?: string; lostContact: boolean; message: string }
function interrupted(failure: unknown, code?: string, name?: string): Device {
  if (failure instanceof RequestError && failure.oauth === 'expired_token' && code && name)
    return { kind: 'expired', code, name }
  return {
    kind: 'failed',
    code,
    name,
    lostContact: failure instanceof NetworkError,
    message:
      failure instanceof RequestError && failure.oauth === 'access_denied'
        ? 'This sign-in was denied in your browser. Start again if you meant to sign in.'
        : errorText(failure),
  }
}
export function App() {
  const [client, setClient] = useState(
    () => new Client(localStorage.getItem('huddle.server') ?? 'http://localhost:3000'),
  )
  const saved = readSavedServers().find((server) => server.origin === client.origin)
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
  useEffect(() => {
    const entry = readSavedServers().find((server) => server.origin === client.origin)
    if (entry) saveServer(entry)
  }, [client])
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
        setDevice(interrupted(failure))
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
        code: code.user_code,
        grant: code,
        expiresAt: Date.now() + code.expires_in * 1000,
        name: info.name,
      })
      await openBrowser(code.verification_uri_complete ?? code.verification_uri)
    } catch (failure) {
      if (!abort.signal.aborted && client.active) setDevice(interrupted(failure))
    }
  }, [client])
  useEffect(() => {
    if (device.kind !== 'waiting') return
    const abort = deviceLifetime.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval = device.grant.interval * 1000
    async function poll() {
      if (stopped || abort.signal.aborted || !client.active || device.kind !== 'waiting') return
      if (Date.now() >= device.expiresAt) {
        setDevice({ kind: 'expired', code: device.code, name: device.name })
        return
      }
      try {
        const result = await client.request(
          '/api/auth/device/token',
          DeviceToken,
          {
            client_id: 'huddle-desktop',
            device_code: device.grant.device_code,
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
          void focusWindow().catch(() => undefined)
        }
      } catch (failure) {
        if (stopped || abort.signal.aborted || !client.active) return
        if (
          failure instanceof RequestError &&
          (failure.oauth === 'authorization_pending' || failure.oauth === 'slow_down')
        ) {
          if (failure.oauth === 'slow_down') interval += 5000
          timer = setTimeout(() => void poll(), interval)
        } else setDevice(interrupted(failure, device.code, device.name))
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
        initialOrigin={localStorage.getItem('huddle.server') ? client.origin : ''}
        connect={changeServer}
        close={localStorage.getItem('huddle.server') ? () => setEditingServer(false) : undefined}
      />
    )
  const server = { name: saved?.name ?? new URL(client.origin).host, origin: client.origin }
  if (device.kind !== 'idle')
    return (
      <BrowserWait
        server={{ ...server, name: ('name' in device && device.name) || server.name }}
        state={device}
        open={() => {
          if (device.kind !== 'waiting') return
          void openBrowser(
            device.grant.verification_uri_complete ?? device.grant.verification_uri,
          ).catch((failure) => setDevice(interrupted(failure, device.code, device.name)))
        }}
        restart={() => void browser()}
        cancel={() => void cancel()}
        onServer={() => setEditingServer(true)}
      />
    )
  return (
    <Application
      key={`${client.origin}:${reload}`}
      client={client}
      serverName={saved?.name}
      onServer={() => setEditingServer(true)}
      browser={browser}
      openBrowser={openBrowser}
    />
  )
}

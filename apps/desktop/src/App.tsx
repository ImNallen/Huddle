import { useEffect, useState } from 'react'
import { inviteOrigin, parseInvite, type FriendInvite } from '@huddle/contracts'
import { Application, Connect, readSavedServers, savedInvite, saveServer } from '@huddle/ui'
import { Client, native, openInvite } from './client'
import { WindowBar } from './WindowBar'

export function App() {
  const [client, setClient] = useState(
    () => new Client(localStorage.getItem('huddle.server') ?? 'http://localhost:3000'),
  )
  const saved = readSavedServers().find((server) => server.origin === client.origin)
  const [editingServer, setEditingServer] = useState(() => !localStorage.getItem('huddle.server'))
  useEffect(() => {
    const entry = readSavedServers().find((server) => server.origin === client.origin)
    if (entry) saveServer(entry)
  }, [client])
  useEffect(() => {
    const stored = savedInvite(client.origin)
    if (!stored) return
    let invite: FriendInvite
    try {
      invite = parseInvite(stored)
    } catch {
      return
    }
    const origin = inviteOrigin(invite)
    if (origin !== client.origin) return
    let cancelled = false
    openInvite(invite.host, invite.port, invite.pin)
      .then((proxy) => {
        if (cancelled) return
        setClient((current) => {
          if (current.origin !== origin) return current
          current.disconnect()
          return new Client(origin, proxy)
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [client.origin])
  async function changeServer(origin: string) {
    await useClient(new Client(origin))
  }
  async function connectInvite(invite: FriendInvite) {
    const proxy = await openInvite(invite.host, invite.port, invite.pin)
    await useClient(new Client(inviteOrigin(invite), proxy))
  }
  async function useClient(next: Client) {
    try {
      const info = await next.info()
      client.disconnect()
      await client.forget()
      saveServer({ origin: next.origin, name: info.name })
      setClient(next)
      setEditingServer(false)
    } catch (failure) {
      next.disconnect()
      if (!client.active) setClient(new Client(client.origin))
      throw failure
    }
  }
  return (
    <>
      {native && <WindowBar title={(!editingServer && saved?.name) || 'Huddle'} />}
      {editingServer ? (
        <Connect
          initialOrigin={localStorage.getItem('huddle.server') ? client.origin : ''}
          connect={changeServer}
          connectInvite={connectInvite}
          close={localStorage.getItem('huddle.server') ? () => setEditingServer(false) : undefined}
        />
      ) : (
        <Application
          key={client.origin}
          client={client}
          serverName={saved?.name}
          onServer={() => setEditingServer(true)}
        />
      )}
    </>
  )
}

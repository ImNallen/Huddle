import { useEffect, useState } from 'react'
import { Application, Connect, readSavedServers, saveServer } from '@huddle/ui'
import { Client, native } from './client'
import { WindowBar } from './WindowBar'

export function App() {
  const [client, setClient] = useState(
    () => new Client(localStorage.getItem('huddle.server') ?? 'http://localhost:3000'),
  )
  const [servers, setServers] = useState(readSavedServers)
  const saved = servers.find((server) => server.origin === client.origin)
  const [editingServer, setEditingServer] = useState(() => !localStorage.getItem('huddle.server'))
  function remember(server: { origin: string; name: string }) {
    saveServer(server)
    setServers(readSavedServers())
  }
  useEffect(() => {
    const entry = readSavedServers().find((server) => server.origin === client.origin)
    if (entry) remember(entry)
  }, [client])
  async function changeServer(origin: string) {
    const next = new Client(origin)
    try {
      const info = await next.info()
      client.disconnect()
      remember({ origin: next.origin, name: info.name })
      setClient(next)
      setEditingServer(false)
    } catch (failure) {
      next.disconnect()
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
          close={localStorage.getItem('huddle.server') ? () => setEditingServer(false) : undefined}
        />
      ) : (
        <Application
          key={client.origin}
          client={client}
          serverName={saved?.name}
          onServer={() => setEditingServer(true)}
          onServerName={(name) => {
            if (name !== saved?.name) remember({ origin: client.origin, name })
          }}
        />
      )}
    </>
  )
}

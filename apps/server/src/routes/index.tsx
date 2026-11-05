import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Application, Connecting, Connection, takeInviteFromAddress } from '@huddle/ui'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const [client, setClient] = useState<Connection | null>(null)
  useEffect(() => {
    takeInviteFromAddress(window.location.origin)
    const connection = new Connection(window.location.origin)
    setClient(connection)
    const onHashChange = () => {
      if (!window.location.hash.startsWith('#join=')) return
      takeInviteFromAddress(window.location.origin)
      window.location.reload()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => {
      window.removeEventListener('hashchange', onHashChange)
      connection.disconnect()
    }
  }, [])
  return client ? <Application client={client} /> : <Connecting />
}

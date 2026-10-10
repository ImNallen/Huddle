import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Application, Connecting, Connection } from '@huddle/ui'
export const Route = createFileRoute('/login')({ component: Login })
function Login() {
  const [client, setClient] = useState<Connection | null>(null)
  useEffect(() => {
    const connection = new Connection(window.location.origin)
    setClient(connection)
    return () => connection.disconnect()
  }, [])
  return client ? <Application client={client} /> : <Connecting />
}

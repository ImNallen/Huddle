import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Connecting, Connection, DeviceApproval } from '@huddle/ui'
export const Route = createFileRoute('/device')({ component: Device })
function Device() {
  const [request, setRequest] = useState<{ client: Connection; code: string } | null>(null)
  useEffect(() => {
    const client = new Connection(window.location.origin)
    setRequest({ client, code: new URLSearchParams(window.location.search).get('user_code') ?? '' })
    return () => client.disconnect()
  }, [])
  return request ? (
    <DeviceApproval client={request.client} initialCode={request.code} />
  ) : (
    <Connecting />
  )
}

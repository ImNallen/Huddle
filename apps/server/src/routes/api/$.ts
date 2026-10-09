import { createFileRoute } from '@tanstack/react-router'
import { getRequestIP } from '@tanstack/react-start/server'
import { applicationRequest } from '../../lib/http'
export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request }) => applicationRequest(request, getRequestIP({ xForwardedFor: false })),
      POST: ({ request }) => applicationRequest(request, getRequestIP({ xForwardedFor: false })),
      OPTIONS: ({ request }) => applicationRequest(request, getRequestIP({ xForwardedFor: false })),
    },
  },
})

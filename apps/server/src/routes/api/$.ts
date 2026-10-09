import { createFileRoute } from '@tanstack/react-router'
import { applicationRequest } from '../../lib/http'
export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request }) => applicationRequest(request),
      POST: ({ request }) => applicationRequest(request),
      OPTIONS: ({ request }) => applicationRequest(request),
    },
  },
})

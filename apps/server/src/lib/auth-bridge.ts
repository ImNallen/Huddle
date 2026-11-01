import { AsyncLocalStorage } from 'node:async_hooks'
import { createAuthEndpoint } from 'better-auth/api'
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies'
import type { Session, User } from 'better-auth'

type Delivery = {
  view: object
  session?: { session: Session; user: User }
  clear?: boolean
  native: boolean
}
export const delivery = new AsyncLocalStorage<Delivery>()
export const bridgePlugin = {
  id: 'huddle-bridge',
  endpoints: {
    huddleResponse: createAuthEndpoint('/huddle/response', { method: 'GET' }, async (ctx) => {
      const output = delivery.getStore()
      if (!output) return ctx.json({ error: 'invalid' }, { status: 403 })
      if (output.clear) deleteSessionCookie(ctx)
      if (!output.native && output.session) await setSessionCookie(ctx, output.session)
      return ctx.json(output.view)
    }),
  },
}

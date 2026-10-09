import { AsyncLocalStorage } from 'node:async_hooks'
import { createAuthEndpoint } from 'better-auth/api'
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies'
import type { Session, User } from 'better-auth'

type Delivery = {
  view: object
  session?: { session: Session; user: User }
  continuation?: string
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
      const cookie = ctx.context.createAuthCookie('huddle_continuation', { maxAge: 900 })
      if (output.clear) deleteSessionCookie(ctx)
      if (!output.native) {
        if (output.session) await setSessionCookie(ctx, output.session)
        if (output.continuation)
          await ctx.setSignedCookie(
            cookie.name,
            output.continuation,
            ctx.context.secret,
            cookie.attributes,
          )
      }
      return ctx.json(output.view)
    }),
    huddleContinuation: createAuthEndpoint(
      '/huddle/continuation',
      { method: 'GET' },
      async (ctx) => {
        const cookie = ctx.context.createAuthCookie('huddle_continuation')
        return ctx.json({
          continuation: (await ctx.getSignedCookie(cookie.name, ctx.context.secret)) || null,
        })
      },
    ),
  },
}

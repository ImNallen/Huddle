import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { config, origins } from './config'
import { db } from './db'
import { bridgePlugin } from './auth-bridge'

export const auth = betterAuth({
  appName: 'Huddle',
  baseURL: config.SERVER_URL,
  secret: config.BETTER_AUTH_SECRET,
  database: db,
  trustedOrigins: [...origins],
  emailAndPassword: { enabled: false },
  session: { cookieCache: { enabled: false } },
  plugins: [bearer(), bridgePlugin],
})

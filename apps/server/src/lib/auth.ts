import { betterAuth } from 'better-auth'
import { bearer, genericOAuth } from 'better-auth/plugins'
import { config, origins } from './config'
import { db } from './db'
import { bridgePlugin } from './auth-bridge'
import { companyAdmission, companySession, companyUser } from './auth-provider'

export const auth = betterAuth({
  appName: 'Huddle',
  baseURL: config.SERVER_URL,
  secret: config.BETTER_AUTH_SECRET,
  database: db,
  trustedOrigins: [...origins],
  emailAndPassword: { enabled: false },
  account: { accountLinking: { enabled: false } },
  databaseHooks: {
    user: { create: { before: companyAdmission } },
    session: { create: { after: companySession } },
  },
  session: { cookieCache: { enabled: false } },
  plugins: [
    bearer(),
    bridgePlugin,
    ...(config.OIDC_DISCOVERY_URL && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET
      ? [
          genericOAuth({
            config: [
              {
                providerId: 'company',
                discoveryUrl: config.OIDC_DISCOVERY_URL,
                clientId: config.OIDC_CLIENT_ID,
                clientSecret: config.OIDC_CLIENT_SECRET,
                scopes: ['openid', 'profile', 'email'],
                pkce: true,
                requireIdTokenVerification: true,
                getUserInfo: companyUser,
              },
            ],
          }),
        ]
      : []),
  ],
})

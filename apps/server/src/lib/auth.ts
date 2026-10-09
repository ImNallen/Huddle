import { betterAuth } from 'better-auth'
import { bearer, deviceAuthorization, genericOAuth } from 'better-auth/plugins'
import { config, origins } from './config'
import { db } from './db'

export const auth = betterAuth({
  appName: 'Huddle',
  baseURL: config.SERVER_URL,
  secret: config.BETTER_AUTH_SECRET,
  database: db,
  trustedOrigins: [...origins],
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  session: { cookieCache: { enabled: false } },
  plugins: [
    bearer(),
    deviceAuthorization({
      verificationUri: `${config.SERVER_URL}/device`,
      validateClient: (clientId) => clientId === 'huddle-desktop',
    }),
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
              },
            ],
          }),
        ]
      : []),
  ],
})

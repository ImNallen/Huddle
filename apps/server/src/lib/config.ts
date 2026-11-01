import { z } from 'zod'
import { serverOrigin } from '@huddle/contracts'

const Environment = z
  .object({
    DATABASE_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    AUTH_ENCRYPTION_KEYS: z
      .string()
      .transform((value) =>
        z
          .array(
            z.object({ version: z.number().int().positive(), secret: z.string().min(32) }).strict(),
          )
          .min(1)
          .parse(JSON.parse(value)),
      )
      .optional(),
    SERVER_URL: z.string().default('http://localhost:3000').transform(serverOrigin),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    BIND_HOST: z.string().trim().min(1).default('127.0.0.1'),
    WS_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    WS_PUBLIC_URL: z.url().default('ws://localhost:3001'),
    TRUSTED_ORIGINS: z
      .string()
      .default(
        'http://localhost:1420,http://127.0.0.1:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost',
      ),
    SETUP_CODE: z.string().trim().min(8).max(64).optional(),
    FRIEND_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  })
  .superRefine((env, ctx) => {
    if (/change|example|secretsecret|password/i.test(env.BETTER_AUTH_SECRET))
      ctx.addIssue({
        code: 'custom',
        message: 'Generate BETTER_AUTH_SECRET with pnpm setup:local.',
      })
    if (env.SERVER_URL.startsWith('https:') && !env.WS_PUBLIC_URL.startsWith('wss:'))
      ctx.addIssue({ code: 'custom', message: 'HTTPS installations require WSS.' })
    const friend = env.FRIEND_PORT ?? (env.PORT + 1000 <= 65535 ? env.PORT + 1000 : env.PORT + 1)
    if (friend === env.PORT || friend === env.WS_PORT)
      ctx.addIssue({ code: 'custom', message: 'FRIEND_PORT must differ from PORT and WS_PORT.' })
  })
const environment = Environment.parse(process.env)
export const config = {
  ...environment,
  FRIEND_PORT:
    environment.FRIEND_PORT ??
    (environment.PORT + 1000 <= 65535 ? environment.PORT + 1000 : environment.PORT + 1),
}
export const origins = new Set([
  config.SERVER_URL,
  ...config.TRUSTED_ORIGINS.split(',').filter(Boolean),
])

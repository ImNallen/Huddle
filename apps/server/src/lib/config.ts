import { z } from 'zod'
import { serverOrigin } from '@huddle/contracts'

const tauriOrigins = ['tauri://localhost', 'https://tauri.localhost']

function refusedForHttps(entry: string): string | null {
  if (tauriOrigins.includes(entry)) return null
  if (!URL.canParse(entry)) return 'it is not an origin'
  const { protocol, hostname } = new URL(entry)
  if (protocol === 'http:') return 'it is plain HTTP'
  const loopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    hostname.startsWith('127.')
  return loopback ? 'it is a loopback address' : null
}

const Environment = z
  .object({
    DATABASE_URL: z.url(),
    SERVER_URL: z.string().default('http://localhost:3000').transform(serverOrigin),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WS_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    WS_PUBLIC_URL: z.url().optional(),
    TRUSTED_ORIGINS: z.string().default(''),
    SETUP_CODE: z.string().trim().min(8).max(64).optional(),
    SOCKET_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(300),
    LIVEKIT_API_KEY: z.string().min(1).default('huddle'),
    LIVEKIT_API_SECRET: z
      .union([z.literal('').transform(() => undefined), z.string().min(32)])
      .optional(),
    LIVEKIT_PORT: z.coerce.number().int().min(1).max(65535).default(7880),
    LIVEKIT_PUBLIC_URL: z.url({ protocol: /^wss?$/ }).optional(),
    VOICE_ACCESS_GRACE_SECONDS: z.coerce.number().int().min(1).default(60),
  })
  .refine(
    (env) => !env.SERVER_URL.startsWith('https:') || !env.LIVEKIT_PUBLIC_URL?.startsWith('ws:'),
    { error: 'An HTTPS SERVER_URL requires a wss: LIVEKIT_PUBLIC_URL.' },
  )
  .transform((parsed) => {
    const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_PORT, LIVEKIT_PUBLIC_URL, ...env } = parsed
    const https = env.SERVER_URL.startsWith('https:')
    return {
      ...env,
      WS_PUBLIC_URL:
        env.WS_PUBLIC_URL ??
        (https ? `wss://${new URL(env.SERVER_URL).host}/events` : `ws://localhost:${env.WS_PORT}`),
      voice: LIVEKIT_API_SECRET
        ? {
            key: LIVEKIT_API_KEY,
            secret: LIVEKIT_API_SECRET,
            url:
              LIVEKIT_PUBLIC_URL ??
              (https
                ? `wss://${new URL(env.SERVER_URL).hostname}:8443`
                : `ws://localhost:${LIVEKIT_PORT}`),
            adminUrl: `http://127.0.0.1:${LIVEKIT_PORT}`,
          }
        : null,
      trusted: env.TRUSTED_ORIGINS.split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    }
  })
  .superRefine((env, ctx) => {
    if (!env.SERVER_URL.startsWith('https:')) return
    if (!env.WS_PUBLIC_URL.startsWith('wss:'))
      ctx.addIssue({
        code: 'custom',
        message: 'An HTTPS SERVER_URL requires a wss: WS_PUBLIC_URL.',
      })
    for (const entry of env.trusted) {
      const reason = refusedForHttps(entry)
      if (reason)
        ctx.addIssue({
          code: 'custom',
          message: `TRUSTED_ORIGINS must not list ${entry} on an HTTPS server, because ${reason}. Any page on a tailnet device acts as that device's person, so a page at that origin could read and write as them. Remove it.`,
        })
    }
  })
export const config = Environment.parse(process.env)
export const origins: ReadonlySet<string> = new Set([
  config.SERVER_URL,
  ...tauriOrigins,
  ...config.trusted,
])
export const serverHosts: ReadonlySet<string> = new Set([
  new URL(config.SERVER_URL).host,
  new URL(config.WS_PUBLIC_URL).host,
])

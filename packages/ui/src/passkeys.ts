import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
  WebAuthnAbortService,
} from '@simplewebauthn/browser'
import { z } from 'zod'
import { AccessView, PasskeyProof, type FactorInput } from '@huddle/contracts'
import type { Transport } from './transport'

const Credential = z.object({
  id: z.string(),
  type: z.literal('public-key'),
  transports: z
    .array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']))
    .optional(),
})
const AuthenticationOptions = z.object({
  challenge: z.string(),
  timeout: z.number().optional(),
  rpId: z.string().optional(),
  allowCredentials: z.array(Credential).optional(),
  userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
})
const RegistrationOptions = z.object({
  challenge: z.string(),
  rp: z.object({ name: z.string(), id: z.string().optional() }),
  user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number() })),
  timeout: z.number().optional(),
  excludeCredentials: z.array(Credential).optional(),
  authenticatorSelection: z
    .object({
      authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
      residentKey: z.enum(['required', 'preferred', 'discouraged']).optional(),
      requireResidentKey: z.boolean().optional(),
      userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
    })
    .optional(),
  attestation: z.enum(['none', 'indirect', 'direct', 'enterprise']).optional(),
})
export async function signInPasskey(client: Transport, signal: AbortSignal) {
  const optionsJSON = await client.request(
    '/api/access/passkey/authenticate/options',
    AuthenticationOptions,
    { purpose: 'signin' },
    signal,
  )
  const response = await ceremony(signal, () => startAuthentication({ optionsJSON }))
  if (signal.aborted || !client.active) throw new DOMException('Cancelled', 'AbortError')
  return client.request(
    '/api/access/passkey/authenticate/verify',
    AccessView,
    { purpose: 'signin', response },
    signal,
  )
}
export async function provePasskey(client: Transport, signal: AbortSignal): Promise<FactorInput> {
  const optionsJSON = await client.request(
    '/api/access/passkey/authenticate/options',
    AuthenticationOptions,
    { purpose: 'reauth' },
    signal,
  )
  const response = await ceremony(signal, () => startAuthentication({ optionsJSON }))
  if (signal.aborted || !client.active) throw new DOMException('Cancelled', 'AbortError')
  const result = await client.request(
    '/api/access/passkey/authenticate/verify',
    PasskeyProof,
    { purpose: 'reauth', response },
    signal,
  )
  return { kind: 'passkey', proof: result.proof }
}
export async function addPasskey(
  client: Transport,
  name: string,
  signal: AbortSignal,
  proof?: FactorInput,
) {
  const optionsJSON = await client.request(
    '/api/access/passkey/register/options',
    RegistrationOptions,
    { name, ...(proof ? { proof } : {}) },
    signal,
  )
  const response = await ceremony(signal, () => startRegistration({ optionsJSON }))
  if (signal.aborted || !client.active) throw new DOMException('Cancelled', 'AbortError')
  return client.request('/api/access/passkey/register/verify', AccessView, response, signal)
}

async function ceremony<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  if (!browserSupportsWebAuthn())
    throw new Error(
      'Passkeys are not supported in this browser. Use email or company sign-in, or try a supported browser.',
    )
  const cancel = () => WebAuthnAbortService.cancelCeremony()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return await run()
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

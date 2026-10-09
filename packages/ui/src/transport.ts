import type { z } from 'zod'
import type { ServerInfo } from '@huddle/contracts'

export interface Transport {
  readonly origin: string
  readonly active: boolean
  request<T>(path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T>
  photo?(id: string, signal: AbortSignal): Promise<string>
  info(): Promise<z.infer<typeof ServerInfo>>
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

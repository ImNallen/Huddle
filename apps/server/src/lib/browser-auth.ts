import { z } from 'zod'
export async function authRequest(path: string, body?: unknown) {
  const response = await fetch(`/api/auth${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data: unknown = await response.json()
  if (!response.ok) {
    const error = z
      .object({ message: z.string().optional(), error_description: z.string().optional() })
      .safeParse(data)
    throw new Error(
      error.success
        ? (error.data.message ?? error.data.error_description ?? 'Unable to complete this request.')
        : 'Unable to complete this request.',
    )
  }
  return data
}

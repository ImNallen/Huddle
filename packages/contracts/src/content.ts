import { z } from 'zod'

export const KLIPY_MEDIA_HOSTS = [
  'static.klipy.com',
  'static1.klipy.com',
  'static2.klipy.com',
] as const

const CanonicalKlipyMediaUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return (
      url.href === value &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (KLIPY_MEDIA_HOSTS as readonly string[]).includes(url.hostname)
    )
  }, 'Use a KLIPY media address')
const Dimension = z.number().int().min(1).max(4096)
export const MessageBody = z.string().trim().min(1).max(8000)

export const GifRef = z.object({
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\s,/?#\x00-\x1f\x7f]+$/),
  title: z
    .string()
    .regex(/^[^\x00-\x1f\x7f]*$/)
    .refine((title) => [...title].length <= 200),
  width: Dimension,
  height: Dimension,
  /** md webp: the transcript's animated rendition. */
  animated: CanonicalKlipyMediaUrl,
  /** md jpg: shown under reduced motion. */
  still: CanonicalKlipyMediaUrl,
})
export type GifRef = z.infer<typeof GifRef>

export type MessageContent = { kind: 'text'; body: string } | { kind: 'gif'; gif: GifRef }

export const ContentFilter = z.enum(['off', 'low', 'medium', 'high'])
export const GifSettings = z.object({
  appKey: z.string().min(1).max(256),
  contentFilter: ContentFilter,
})
export type GifSettings = z.infer<typeof GifSettings>

export function readContent(fields: { body: string; gif: GifRef | null }): MessageContent {
  return fields.gif ? { kind: 'gif', gif: fields.gif } : { kind: 'text', body: fields.body }
}
export function storedFields(content: MessageContent): { body: string; gif: GifRef | null } {
  return content.kind === 'gif'
    ? { body: plainText(content), gif: content.gif }
    : { body: content.body, gif: null }
}
export function sendFields(content: MessageContent): { body: string } | { gif: GifRef } {
  return content.kind === 'gif' ? { gif: content.gif } : { body: content.body }
}
export function plainText(content: MessageContent): string {
  if (content.kind === 'text') return content.body
  return content.gif.title ? `GIF · ${content.gif.title}` : 'GIF'
}
export function sameContent(a: MessageContent, b: MessageContent): boolean {
  if (a.kind === 'text' || b.kind === 'text')
    return a.kind === 'text' && b.kind === 'text' && a.body === b.body
  return GifRef.keyof().options.every((key) => a.gif[key] === b.gif[key])
}
/** A scope, a retryId and exactly one of `body` or `gif`, parsed into `content`. Zod cannot name
 *  a generic object's output inside this function, so each branch states the shape it just parsed. */
export function sendRequest<Scope extends z.ZodRawShape>(scope: Scope) {
  type Request = z.output<z.ZodObject<Scope>> & { retryId: string; content: MessageContent }
  const text = z
    .object({ ...scope, retryId: z.uuid(), body: MessageBody })
    .strict()
    .transform((input) => {
      const { body, ...rest } = input as { body: string }
      return { ...rest, content: { kind: 'text', body } } as Request
    })
  const gif = z
    .object({ ...scope, retryId: z.uuid(), gif: GifRef.strict() })
    .strict()
    .transform((input) => {
      const { gif, ...rest } = input as { gif: GifRef }
      return { ...rest, content: { kind: 'gif', gif } } as Request
    })
  return z.union([text, gif])
}

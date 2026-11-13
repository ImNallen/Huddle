import { z } from 'zod'
import { GifRef, type GifSettings } from '@huddle/contracts'
import { fetchAnonymous } from '../outbound'

const API = 'https://api.klipy.com/api/v1'
const PER_PAGE = 24
const PAGE_BYTES = 1024 * 1024
const CATEGORY_BYTES = 256 * 1024
const TIMEOUT_MS = 8000
const MAX_TITLE = 200
const MAX_CATEGORY = 40
const MAX_PLACEHOLDER = 8000

export type GifFeed = { kind: 'trending' } | { kind: 'search'; query: string }
/** One KLIPY result, in KLIPY's place. A result that cannot become a valid GifRef is still shown, as
 *  unavailable, because KLIPY's terms forbid removing results. */
export type GifResult =
  | {
      kind: 'gif'
      ref: GifRef
      thumb: string
      placeholder: string | null
    }
  | { kind: 'unavailable'; title: string; width: number; height: number }
export type GifPage = { results: GifResult[]; next: number | null }
export type GifCategory = { name: string; query: string }
export type Klipy = {
  browse(feed: GifFeed, page: number, signal: AbortSignal): Promise<GifPage>
  categories(signal: AbortSignal): Promise<GifCategory[]>
}

const MediaUrl = GifRef.shape.animated
const Rendition = z.object({ url: z.string(), width: z.number(), height: z.number() })
const Formats = z.object({
  webp: Rendition.optional().catch(undefined),
  jpg: Rendition.optional().catch(undefined),
})
const Item = z.object({
  slug: z.string(),
  title: z.string().catch(''),
  file: z
    .object({
      md: Formats.optional().catch(undefined),
      sm: Formats.optional().catch(undefined),
    })
    .catch({}),
  blur_preview: z.string().optional().catch(undefined),
})
const Page = z.object({
  result: z.literal(true),
  data: z.object({ data: z.array(z.unknown()), has_next: z.boolean().catch(false) }),
})
const Categories = z.object({
  data: z.object({ categories: z.array(z.unknown()) }),
})
const Category = z.object({ category: z.string(), query: z.string() })

function clean(text: string, limit: number) {
  const words = text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...words].slice(0, limit).join('').trimEnd()
}

function shapeOf(...renditions: (z.infer<typeof Rendition> | undefined)[]) {
  const usable = renditions.find(
    (rendition) =>
      rendition &&
      Number.isFinite(rendition.width) &&
      Number.isFinite(rendition.height) &&
      rendition.width > 0 &&
      rendition.height > 0,
  )
  return usable ? { width: usable.width, height: usable.height } : { width: 1, height: 1 }
}

function toResult(raw: unknown): GifResult {
  const item = Item.safeParse(raw)
  if (!item.success) return { kind: 'unavailable', title: '', width: 1, height: 1 }
  const { slug, file, blur_preview } = item.data
  const title = clean(item.data.title, MAX_TITLE)
  const animated = file.md?.webp
  const ref = GifRef.safeParse({
    slug,
    title,
    width: animated?.width,
    height: animated?.height,
    animated: animated?.url,
    still: file.md?.jpg?.url,
  })
  if (!ref.success)
    return { kind: 'unavailable', title, ...shapeOf(file.sm?.webp, animated, file.md?.jpg) }
  const small = file.sm?.webp?.url
  return {
    kind: 'gif',
    ref: ref.data,
    thumb: small && MediaUrl.safeParse(small).success ? small : ref.data.animated,
    placeholder:
      blur_preview &&
      blur_preview.length <= MAX_PLACEHOLDER &&
      /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(blur_preview)
        ? blur_preview
        : null,
  }
}

export function createKlipy(settings: GifSettings): Klipy {
  const base = `${API}/${encodeURIComponent(settings.appKey)}/gifs`
  return {
    async browse(feed, page, signal) {
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(PER_PAGE),
        content_filter: settings.contentFilter,
        format_filter: 'webp,jpg',
      })
      if (feed.kind === 'search') params.set('q', feed.query)
      const text = await fetchAnonymous(`${base}/${feed.kind}?${params}`, {
        limit: PAGE_BYTES,
        timeout: TIMEOUT_MS,
        signal,
      })
      const body = Page.parse(JSON.parse(text))
      return {
        results: body.data.data.map(toResult),
        next: body.data.has_next ? page + 1 : null,
      }
    },
    async categories(signal) {
      const text = await fetchAnonymous(`${base}/categories`, {
        limit: CATEGORY_BYTES,
        timeout: TIMEOUT_MS,
        signal,
      })
      return Categories.parse(JSON.parse(text)).data.categories.flatMap((raw) => {
        const category = Category.safeParse(raw)
        if (!category.success) return []
        const name = clean(category.data.category, MAX_CATEGORY)
        const query = clean(category.data.query, MAX_TITLE)
        if (!name || !query) return []
        return [{ name: name.replace(/^\p{Ll}/u, (first) => first.toLocaleUpperCase()), query }]
      })
    },
  }
}

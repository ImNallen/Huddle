import type { BrowserContext } from '@playwright/test'
import { GifRef } from '../packages/contracts/src/index'

type Seen = { url: string; referer?: string; cookie?: string }
type Media = { gif: GifRef; still: boolean; tint: string }

const tints = ['#c4b5fd', '#99dbb6', '#f9a8d4', '#93c5fd', '#fcd34d']

function picture({ gif, still, tint }: Media) {
  const { width, height } = gif
  const radius = Math.min(width, height) / 3
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${tint}"/>
  ${still ? `<rect width="${width}" height="${height}" fill="#000000" fill-opacity="0.18"/>` : ''}
  <circle cx="${width / 2}" cy="${height / 2}" r="${radius}" fill="#ffffff" fill-opacity="0.4"/>
  <circle cx="${width / 2}" cy="${height / 2}" r="${radius / 2.2}" fill="#fbbf24"/>
</svg>`
}

const KEY = 'huddle-suite-klipy-key'
const thumbOf = (gif: GifRef) => `https://static2.klipy.com/ii/${gif.slug}/sm.webp`
type Flawed = { slug: string; title: string; flaw: 'no still' | 'off host' }
type Listing = GifRef | Flawed

function wire(listing: Listing) {
  const { slug, title } = listing
  const rendition = (url: string, width = 498, height = 280) => ({ url, width, height, size: 1000 })
  const file =
    'flaw' in listing
      ? listing.flaw === 'no still'
        ? { md: { webp: rendition(`https://static.klipy.com/ii/${slug}/md.webp`) } }
        : {
            md: {
              webp: rendition(`https://media.evil.test/${slug}/md.webp`),
              jpg: rendition(`https://media.evil.test/${slug}/md.jpg`),
            },
          }
      : {
          md: {
            webp: rendition(listing.animated, listing.width, listing.height),
            jpg: rendition(listing.still, listing.width, listing.height),
          },
          sm: {
            webp: rendition(
              thumbOf(listing),
              220,
              Math.round((220 * listing.height) / listing.width),
            ),
          },
        }
  return { id: 8041071659142944, slug, title, file, tags: [], type: 'gif' }
}

export async function stubKlipy(context: BrowserContext) {
  const known = new Map<string, Media>()
  const gates = new Map<string, Promise<'serve' | 'abort'>>()
  const seen: Seen[] = []
  const unexpected: string[] = []
  const api: { url: URL; referer?: string; cookie?: string }[] = []
  const feeds = new Map<string, Listing[][]>()
  const held = new Map<string, Promise<void>>()
  const down = new Set<string>()
  let categories: { category: string; query: string }[] = []
  await context.route(/^https:\/\/([^/]+\.)?klipy\.com\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const headers = await request.allHeaders()
    if (url.hostname === 'api.klipy.com') {
      const [, key, endpoint] = /^\/api\/v1\/([^/]+)\/gifs\/([a-z]+)$/.exec(url.pathname) ?? []
      if (key !== KEY || !endpoint || !['trending', 'search', 'categories'].includes(endpoint)) {
        unexpected.push(request.url())
        return route.abort('blockedbyclient')
      }
      api.push({ url, referer: headers.referer, cookie: headers.cookie })
      const feed = endpoint === 'search' ? (url.searchParams.get('q') ?? '') : endpoint
      await held.get(feed)
      if (down.has(feed)) return route.abort('failed')
      const cors = { 'access-control-allow-origin': '*' }
      if (feed === 'categories')
        return route.fulfill({
          headers: cors,
          json: { result: true, data: { locale: 'en_US', categories } },
        })
      const pages = feeds.get(feed) ?? []
      const page = Number(url.searchParams.get('page'))
      return route.fulfill({
        headers: cors,
        json: {
          result: true,
          data: {
            data: (pages[page - 1] ?? []).map(wire),
            current_page: page,
            per_page: 24,
            has_next: page < pages.length,
          },
        },
      })
    }
    const media = known.get(request.url())
    if (!media) {
      unexpected.push(request.url())
      return route.abort('blockedbyclient')
    }
    seen.push({ url: request.url(), referer: headers.referer, cookie: headers.cookie })
    if ((await gates.get(request.url())) === 'abort') return route.abort('failed')
    await route.fulfill({ contentType: 'image/svg+xml', body: picture(media) })
  })
  return {
    seen,
    unexpected,
    api,
    gif(slug: string, title: string, width = 498, height = 280) {
      const gif = GifRef.parse({
        slug,
        title,
        width,
        height,
        animated: `https://static.klipy.com/ii/${slug}/md.webp`,
        still: `https://static1.klipy.com/ii/${slug}/md.jpg`,
      })
      const tint = tints[known.size % tints.length] ?? '#c4b5fd'
      known.set(gif.animated, { gif, still: false, tint })
      known.set(gif.still, { gif, still: true, tint })
      known.set(thumbOf(gif), { gif, still: false, tint })
      return gif
    },
    flawed: (slug: string, title: string, flaw: Flawed['flaw']): Flawed => ({ slug, title, flaw }),
    feed(name: string, pages: Listing[][]) {
      feeds.set(name, pages)
    },
    categories(list: [name: string, query: string][]) {
      categories = list.map(([category, query]) => ({ category, query }))
    },
    fail: (name: string) => void down.add(name),
    restore: (name: string) => void down.delete(name),
    holdFeed(name: string) {
      let release = () => {}
      held.set(
        name,
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      return () => {
        held.delete(name)
        release()
      }
    },
    hold(gif: GifRef) {
      let settle = (_: 'serve' | 'abort') => {}
      const gate = new Promise<'serve' | 'abort'>((resolve) => {
        settle = resolve
      })
      gates.set(gif.animated, gate)
      gates.set(gif.still, gate)
      return { serve: () => settle('serve'), abort: () => settle('abort') }
    },
  }
}

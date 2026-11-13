import { readdirSync, readFileSync } from 'node:fs'
import {
  Admission,
  ChannelId,
  ConversationId,
  DirectMessage,
  GifRef,
  GroupId,
  GroupMessage,
  KLIPY_MEDIA_HOSTS,
  Message,
  plainText,
  readContent,
  sameContent,
  sendFields,
  storedFields,
  UserId,
  type MessageContent,
} from '@huddle/contracts'
import { threadMessage, type Pending, type Thread } from '../chat'
import { initialGroups, snapshotGroups } from '../groupState'
import { readOutbox, writeOutbox } from '../outbox'
import { fetchAnonymous, OutboundError } from '../outbound'
import { gifBox } from './GifMessage'
import { masonry, neighbor, type GridKey } from './grid'
import { createKlipy, type GifResult } from './klipy'

const failures: string[] = []
let checks = 0
function expect(ok: boolean, message: string) {
  checks++
  if (!ok) failures.push(message)
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  )
function equal(actual: unknown, wanted: unknown, message: string) {
  const [got, want] = [canonical(actual), canonical(wanted)]
  expect(got === want, `${message}: got ${got?.slice(0, 300)}, wanted ${want?.slice(0, 300)}`)
}

const gif: GifRef = GifRef.parse({
  slug: 'high-five-team',
  title: 'High five, team',
  width: 498,
  height: 280,
  animated: 'https://static.klipy.com/ii/high-five/md.webp',
  still: 'https://static1.klipy.com/ii/high-five/md.jpg',
})
const untitled: GifRef = { ...gif, slug: 'untitled', title: '' }
const text: MessageContent = { kind: 'text', body: 'Hello there' }
const picture: MessageContent = { kind: 'gif', gif }

function checkCodec() {
  equal(readContent({ body: 'Hello there', gif: null }), text, 'a row with no GIF is text')
  equal(readContent({ body: 'GIF · High five, team', gif }), picture, 'a present GIF wins')
  equal(storedFields(text), { body: 'Hello there', gif: null }, 'text stores its body')
  equal(
    storedFields(picture),
    { body: 'GIF · High five, team', gif },
    'a GIF stores its label as the body older clients show',
  )
  equal(storedFields({ kind: 'gif', gif: untitled }).body, 'GIF', 'an untitled GIF is labelled GIF')
  equal(sendFields(text), { body: 'Hello there' }, 'text sends only its body')
  equal(sendFields(picture), { gif }, 'a GIF sends only its ref')
  equal(plainText(text), 'Hello there', 'plain text of text is the body')
  equal(plainText(picture), 'GIF · High five, team', 'plain text of a GIF names it')
  equal(plainText({ kind: 'gif', gif: untitled }), 'GIF', 'plain text of an untitled GIF')
  for (const content of [text, picture])
    equal(readContent(storedFields(content)), content, `${content.kind} survives storage`)
  expect(sameContent(text, { kind: 'text', body: 'Hello there' }), 'equal text is the same')
  expect(!sameContent(text, { kind: 'text', body: 'Hello' }), 'other text differs')
  expect(sameContent(picture, { kind: 'gif', gif: { ...gif } }), 'an equal ref is the same')
  for (const key of GifRef.keyof().options) {
    const changed = { ...gif, [key]: typeof gif[key] === 'number' ? 1 : `${gif[key]}x` }
    expect(!sameContent(picture, { kind: 'gif', gif: changed }), `a changed ${key} differs`)
  }
  expect(
    !sameContent(text, { kind: 'text', body: 'GIF · High five, team' }) &&
      !sameContent({ kind: 'text', body: 'GIF · High five, team' }, picture) &&
      !sameContent(picture, { kind: 'text', body: 'GIF · High five, team' }),
    'text never matches a GIF, even its label',
  )
}

const wire = {
  id: '6f1c1d8e-4a52-4d4a-9a83-0d6f2b6c0a11',
  authorId: '5c0c2f3a-12f4-4c1c-9a1e-6e6b1d2f3a44',
  authorName: 'Maya',
  authorAvatar: null,
  retryId: '0b8f7a2c-3e1d-4f5a-8b6c-7d9e0f1a2b33',
  body: 'Morning everyone.',
  cursor: '42',
  createdAt: '2026-11-13T10:00:00.000Z',
}
const channelId = ChannelId.parse('8a4f6b2c-1d3e-4f5a-9b7c-2e1d0f9a8b77')
const conversationId = ConversationId.parse('1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a66')
const groupId = GroupId.parse('9f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a55')
const channel: Thread = { kind: 'channel', id: channelId }

function checkThreadMessage() {
  const old = threadMessage(Message.parse({ ...wire, channelId }), channel)
  equal(old.content, { kind: 'text', body: wire.body }, 'a message from before GIFs is text')
  equal(
    Object.keys(old).sort(),
    [
      'authorAvatar',
      'authorId',
      'authorName',
      'content',
      'createdAt',
      'cursor',
      'editedAt',
      'id',
      'reactionRevision',
      'reactions',
      'retryId',
      'revision',
      'thread',
    ],
    'a transcript message carries content and thread, never the wire body, gif, or scope',
  )
  const future = threadMessage(
    Message.parse({
      ...wire,
      channelId,
      body: 'GIF · Wave',
      gif: { kind: 'sticker', id: 7 },
    }),
    channel,
  )
  equal(future.content, { kind: 'text', body: 'GIF · Wave' }, 'an unreadable GIF shows its label')
  const direct = threadMessage(
    DirectMessage.parse({ ...wire, conversationId, body: 'GIF · High five, team', gif }),
    { kind: 'direct', id: conversationId },
  )
  equal(direct.content, picture, 'a direct GIF reads as a GIF')
  expect(!('conversationId' in direct), 'a direct message drops its conversation ID')
  const group = threadMessage(
    GroupMessage.parse({ ...wire, groupId, body: 'GIF · High five, team', gif }),
    { kind: 'group', id: groupId, admission: Admission.parse('3') },
  )
  equal(group.content, picture, 'a group GIF reads as a GIF')
  expect(!('groupId' in group), 'a group message drops its group ID')
}

function checkOutbox() {
  const store = new Map<string, string>()
  let full = false
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (full) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        store.set(key, value)
      },
    },
  })
  const key = 'huddle.outbox:http://localhost:3400:user'
  const thread = channel
  const items: Pending[] = [
    { retryId: wire.retryId, thread, content: text, kind: 'sending' },
    { retryId: wire.id, thread, content: picture, kind: 'failed', error: 'Offline' },
  ]
  expect(writeOutbox(key, items), 'the outbox writes')
  equal(
    JSON.parse(store.get(key) ?? '[]'),
    [
      { retryId: wire.retryId, thread, kind: 'sending', body: 'Hello there' },
      { retryId: wire.id, thread, kind: 'failed', error: 'Offline', gif },
    ],
    'text keeps the stored shape earlier releases read, and a GIF stores only its ref',
  )
  const interrupted = 'Sending was interrupted. Retry with the same message ID.'
  equal(
    readOutbox(key),
    items.map((item) => ({ ...item, kind: 'failed', error: interrupted })),
    'every restored entry is failed with its content intact',
  )
  store.set(
    key,
    JSON.stringify([
      { retryId: wire.retryId, channelId, body: 'Before directs', kind: 'failed', error: 'x' },
      { retryId: 'not-a-uuid', thread, body: 'Broken', kind: 'failed' },
      {
        retryId: wire.authorId,
        thread,
        gif: { ...gif, animated: 'https://evil.test/a.webp' },
        kind: 'failed',
      },
      { retryId: wire.id, thread, gif, kind: 'sending' },
    ]),
  )
  equal(
    readOutbox(key).map((entry) => [entry.retryId, entry.thread, entry.content]),
    [
      [wire.retryId, thread, { kind: 'text', body: 'Before directs' }],
      [wire.id, thread, picture],
    ],
    'a legacy channel entry still reads, and one bad entry drops only itself',
  )
  const admitted = (admission: string): Thread => ({
    kind: 'group',
    id: groupId,
    admission: Admission.parse(admission),
  })
  const me = UserId.parse(wire.authorId)
  store.set(
    key,
    JSON.stringify([
      { retryId: wire.retryId, thread: admitted('5'), body: 'Still here?', kind: 'failed' },
      { retryId: wire.id, thread: admitted('2'), gif, kind: 'failed' },
    ]),
  )
  const reloaded = snapshotGroups(
    initialGroups(readOutbox(key)),
    [
      {
        id: groupId,
        name: 'Weekend',
        members: [{ userId: me, admission: Admission.parse('5') }],
        revision: '5',
        latest: null,
        readCursor: '5',
        unread: 0,
      },
    ],
    '10',
    me,
  )
  equal(
    reloaded.pending.map((entry) => [entry.retryId, entry.thread, entry.content]),
    [[wire.retryId, admitted('5'), { kind: 'text', body: 'Still here?' }]],
    'after a reload a group entry keeps the current admission and drops an earlier one',
  )
  store.set(key, '{"not": "a list"}')
  equal(readOutbox(key), [], 'a stored value that is not a list reads as empty')
  store.set(key, 'not json')
  equal(readOutbox(key), [], 'unreadable storage reads as empty')
  full = true
  expect(!writeOutbox(key, items), 'a full store reports the failed write')
}

function checkBox() {
  const table: [size: [number, number], box: [number, number]][] = [
    [
      [320, 180],
      [320, 180],
    ],
    [
      [498, 280],
      [400, 225],
    ],
    [
      [400, 300],
      [400, 300],
    ],
    [
      [300, 600],
      [150, 300],
    ],
    [
      [100, 50],
      [100, 50],
    ],
    [
      [4096, 4096],
      [300, 300],
    ],
    [
      [4096, 1],
      [400, 40],
    ],
    [
      [1, 4096],
      [40, 300],
    ],
    [
      [1, 1],
      [40, 40],
    ],
  ]
  for (const [[width, height], [boxWidth, boxHeight]] of table)
    equal(gifBox({ width, height }), { width: boxWidth, height: boxHeight }, `${width}x${height}`)
}

function checkDesktopCsp() {
  const config = JSON.parse(
    readFileSync(
      new URL('../../../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url),
      'utf8',
    ),
  ) as { app: { security: { csp: string } } }
  const imgSrc = config.app.security.csp
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .find(([name]) => name === 'img-src')
  if (!imgSrc) throw new Error('The desktop CSP lost its img-src.')
  const klipy = imgSrc.filter((source) => /klipy/i.test(source)).sort()
  equal(
    klipy,
    KLIPY_MEDIA_HOSTS.map((host) => `https://${host}`).sort(),
    'the desktop CSP allows images from exactly KLIPY_MEDIA_HOSTS',
  )
  expect(
    !/media-src/.test(config.app.security.csp),
    'GIFs render through <img>, so the desktop CSP needs no media-src',
  )
}

function checkGrid() {
  const square = { width: 193, height: 193 }
  const wide = { width: 498, height: 280 }
  const tall = { width: 100, height: 300 }
  const banner = { width: 4096, height: 1 }
  const { placements, height } = masonry([square, wide, tall, banner])
  equal(
    placements,
    [
      { column: 0, top: 0, height: 193 },
      { column: 1, top: 0, height: 109 },
      { column: 1, top: 117, height: 280 },
      { column: 0, top: 201, height: 72 },
    ],
    'each tile goes, in order, to the foot of the shorter column, with extreme shapes clamped',
  )
  equal(height, 397, 'the grid is as tall as its taller column')
  equal(masonry([]), { placements: [], height: 0 }, 'an empty grid has no height')
  const all = [true, true, true, true]
  const moves: [from: number, key: GridKey, to: number | null, usable?: boolean[]][] = [
    [0, 'ArrowDown', 3],
    [3, 'ArrowUp', 0],
    [0, 'ArrowUp', null],
    [3, 'ArrowDown', null],
    [0, 'ArrowRight', 1],
    [3, 'ArrowRight', 2],
    [2, 'ArrowLeft', 3],
    [1, 'ArrowLeft', 0],
    [0, 'ArrowLeft', null],
    [1, 'ArrowRight', null],
    [2, 'Home', 0],
    [0, 'End', 3],
    [0, 'ArrowRight', 2, [true, false, true, true]],
    [2, 'ArrowUp', null, [true, false, true, true]],
    [1, 'Home', 1, [false, true, true, true]],
  ]
  for (const [from, key, to, usable = all] of moves)
    equal(neighbor(placements, usable, from, key), to, `${key} from tile ${from}`)
}

function shippedSources(folder: URL): { path: string; text: string }[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path) && !/(^|\/)check\.ts$/.test(path))
    .map((path) => ({ path, text: readFileSync(new URL(path, folder), 'utf8') }))
}

function checkOutsideRequests() {
  const ui = shippedSources(new URL('../', import.meta.url))
  const desktop = shippedSources(new URL('../../../../apps/desktop/src/', import.meta.url))
  const sources = [
    ...ui.map((file) => ({ ...file, path: `packages/ui/src/${file.path}` })),
    ...desktop.map((file) => ({ ...file, path: `apps/desktop/src/${file.path}` })),
  ]
  expect(sources.length > 20, 'the structural checks read the client sources')
  equal(
    sources.filter((file) => file.text.includes('api.klipy.com')).map((file) => file.path),
    ['packages/ui/src/gifs/klipy.ts'],
    'only the KLIPY client names the KLIPY API',
  )
  equal(
    sources
      .filter((file) => /\bfetch\(/.test(file.text))
      .map((file) => file.path)
      .sort(),
    ['packages/ui/src/connection.ts', 'packages/ui/src/outbound.ts'],
    'the client fetches from its own server in connection.ts and from anyone else through outbound.ts',
  )
}

type Answer = { status?: number; body: string } | 'hang'
type Sent = { url: string; init: RequestInit | undefined }
const sent: Sent[] = []
let answer: (url: string) => Answer = () => ({ body: '{}' })
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  sent.push({ url, init })
  const reply = answer(url)
  if (reply === 'hang')
    return new Promise((_, reject) =>
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      ),
    )
  return Promise.resolve(new Response(reply.body, { status: reply.status ?? 200 }))
}) as typeof fetch

const media = (slug: string, file: string, host = 'static.klipy.com') =>
  `https://${host}/ii/${slug}/${file}`
const BLUR = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='
const files = (slug: string) => ({
  hd: { webp: { url: media(slug, 'hd.webp'), width: 996, height: 560, size: 2_000_000 } },
  md: {
    webp: { url: media(slug, 'md.webp'), width: 498, height: 280, size: 643_000 },
    jpg: { url: media(slug, 'md.jpg', 'static1.klipy.com'), width: 498, height: 280 },
  },
  sm: { webp: { url: media(slug, 'sm.webp', 'static2.klipy.com'), width: 220, height: 124 } },
})
function item(slug: string, title: unknown, file: object = files(slug), extra: object = {}) {
  return {
    id: 8041071659142944123,
    slug,
    title,
    file,
    tags: ['wave'],
    type: 'gif',
    blur_preview: BLUR,
    ...extra,
  }
}
const page = (items: unknown[], hasNext = true) =>
  JSON.stringify({
    result: true,
    data: { data: items, current_page: 1, per_page: 24, has_next: hasNext },
  })
const sendable = (
  slug: string,
  title: string,
  thumb = media(slug, 'sm.webp', 'static2.klipy.com'),
): Extract<GifResult, { kind: 'gif' }> => ({
  kind: 'gif',
  ref: {
    slug,
    title,
    width: 498,
    height: 280,
    animated: media(slug, 'md.webp'),
    still: media(slug, 'md.jpg', 'static1.klipy.com'),
  },
  thumb,
  placeholder: BLUR,
})
async function failure(work: Promise<unknown>) {
  try {
    await work
    return 'resolved'
  } catch (cause) {
    return cause instanceof OutboundError
      ? cause.reason
      : cause instanceof DOMException
        ? cause.name
        : 'error'
  }
}

async function checkKlipy() {
  const signal = new AbortController().signal
  const klipy = createKlipy({ appKey: 'suite.key-1~x', contentFilter: 'medium' })
  const items = [
    item('wave-hello-1', 'Wave hello'),
    item('no-still', 'No still', { ...files('no-still'), md: { webp: files('no-still').md.webp } }),
    item('off-host', 'Off host', {
      ...files('off-host'),
      md: {
        ...files('off-host').md,
        webp: { url: 'https://static.klipy.com.evil.test/a.webp', width: 498, height: 280 },
      },
    }),
    'not an item',
    { title: 'No slug', file: files('no-slug') },
    item('spaced slug', 'Spaced slug'),
    item('huge', 'Huge', {
      ...files('huge'),
      md: {
        ...files('huge').md,
        webp: { url: media('huge', 'md.webp'), width: 5000, height: 5000 },
      },
    }),
    item('messy', '  Big\n\tday\u0000 \u007f\u0085 ahead  '),
    item('long', `${'😀'.repeat(150)} ${'é'.repeat(100)}`),
    item('thumb-off-host', 'Thumb off host', {
      ...files('thumb-off-host'),
      sm: { webp: { url: 'http://static.klipy.com/ii/a/sm.webp', width: 220, height: 124 } },
    }),
    item('svg-blur', 'Svg blur', undefined, { blur_preview: 'data:image/svg+xml;base64,PHN2Zz4=' }),
    item('quoted-blur', 'Quoted blur', undefined, { blur_preview: 'data:image/jpeg;base64,AA")' }),
    item('untitled', null),
  ]
  answer = () => ({ body: page(items) })
  const first = await klipy.browse({ kind: 'trending' }, 1, signal)
  equal(
    sent.map((request) => request.url),
    [
      'https://api.klipy.com/api/v1/suite.key-1~x/gifs/trending?page=1&per_page=24&content_filter=medium&format_filter=webp%2Cjpg',
    ],
    'Trending asks for one page of webp and jpg renditions, with no customer ID or locale',
  )
  equal(
    sent.map(({ init }) => [init?.credentials, init?.referrerPolicy, init?.method, init?.headers]),
    [['omit', 'no-referrer', undefined, undefined]],
    'a KLIPY request is a plain GET that carries no cookies, referrer or extra headers',
  )
  const unavailable = (title: string, width = 1, height = 1): GifResult => ({
    kind: 'unavailable',
    title,
    width,
    height,
  })
  const wanted: GifResult[] = [
    sendable('wave-hello-1', 'Wave hello'),
    unavailable('No still', 220, 124),
    unavailable('Off host', 220, 124),
    unavailable(''),
    unavailable(''),
    unavailable('Spaced slug', 220, 124),
    unavailable('Huge', 220, 124),
    sendable('messy', 'Big day ahead'),
    sendable('long', `${'😀'.repeat(150)} ${'é'.repeat(49)}`),
    sendable('thumb-off-host', 'Thumb off host', media('thumb-off-host', 'md.webp')),
    { ...sendable('svg-blur', 'Svg blur'), placeholder: null },
    { ...sendable('quoted-blur', 'Quoted blur'), placeholder: null },
    sendable('untitled', ''),
  ]
  equal(first.results.length, wanted.length, 'every KLIPY result keeps a place')
  for (const [index, result] of wanted.entries())
    equal(first.results[index], result, `KLIPY result ${index} keeps its place, sendable or not`)
  for (const result of first.results)
    if (result.kind === 'gif')
      expect(GifRef.strict().safeParse(result.ref).success, `${result.ref.slug} is a sendable ref`)
  equal(first.next, 2, 'a page with more after it names the next page')

  sent.length = 0
  answer = () => ({ body: page([item('high-five', 'High five')], false) })
  const searched = await createKlipy({ appKey: 'odd/key?#', contentFilter: 'off' }).browse(
    { kind: 'search', query: 'high five & more' },
    3,
    signal,
  )
  equal(
    sent.map((request) => request.url),
    [
      'https://api.klipy.com/api/v1/odd%2Fkey%3F%23/gifs/search?page=3&per_page=24&content_filter=off&format_filter=webp%2Cjpg&q=high+five+%26+more',
    ],
    'a search carries its words and the host filter, and the key stays one path segment',
  )
  equal(searched.next, null, 'the last page names no next page')

  answer = () => ({
    body: JSON.stringify({ result: true, data: { data: [item('a', 'A')] } }),
  })
  equal((await klipy.browse({ kind: 'trending' }, 1, signal)).next, null, 'no has_next, no next')

  const refusals: [name: string, reply: Answer, reason: string][] = [
    ['a server error', { status: 500, body: '{}' }, 'refused'],
    ['an unknown key', { status: 401, body: '{"result":false}' }, 'refused'],
    ['result false', { body: JSON.stringify({ result: false, data: { data: [] } }) }, 'error'],
    ['no list', { body: JSON.stringify({ result: true, data: {} }) }, 'error'],
    ['not JSON', { body: '<html>' }, 'error'],
    ['a page over 1 MB', { body: page([{ padding: 'x'.repeat(1024 * 1024) }]) }, 'oversized'],
  ]
  for (const [name, reply, reason] of refusals) {
    answer = () => reply
    equal(await failure(klipy.browse({ kind: 'trending' }, 1, signal)), reason, name)
  }
  const leaving = new AbortController()
  answer = () => 'hang'
  const left = failure(klipy.browse({ kind: 'trending' }, 1, leaving.signal))
  leaving.abort()
  equal(await left, 'AbortError', 'a closed picker abandons its request')

  sent.length = 0
  answer = () => ({
    body: JSON.stringify({
      result: true,
      data: {
        locale: 'en_US',
        categories: [
          { category: 'high five', query: 'high five', preview_url: media('a', 'a.gif') },
          { category: 'éclair', query: 'eclair', preview_url: 'https://evil.test/a.gif' },
          { category: 5, query: 'five' },
          { category: '', query: 'empty' },
          { category: 'lol\n', query: '  lol ' },
          { category: '42', query: '42' },
        ],
      },
    }),
  })
  equal(
    await klipy.categories(signal),
    [
      { name: 'High five', query: 'high five' },
      { name: 'Éclair', query: 'eclair' },
      { name: 'Lol', query: 'lol' },
      { name: '42', query: '42' },
    ],
    'categories keep KLIPY order, drop what cannot be a chip, and read as labels',
  )
  equal(
    sent.map((request) => request.url),
    ['https://api.klipy.com/api/v1/suite.key-1~x/gifs/categories'],
    'categories are asked for with nothing but the key',
  )
  answer = () => ({ status: 503, body: '' })
  equal(await failure(klipy.categories(signal)), 'refused', 'categories report an outage')
}

async function checkTimeout() {
  answer = () => 'hang'
  const signal = new AbortController().signal
  equal(
    await failure(fetchAnonymous('https://example.test/', { limit: 10, timeout: 20, signal })),
    'timeout',
    'a service that never answers times out',
  )
  answer = () => ({ body: '12345678901' })
  equal(
    await failure(fetchAnonymous('https://example.test/', { limit: 10, timeout: 1000, signal })),
    'oversized',
    'a body past the cap is refused',
  )
  answer = () => ({ body: '1234567890' })
  equal(
    await fetchAnonymous('https://example.test/', { limit: 10, timeout: 1000, signal }),
    '1234567890',
    'a body at the cap is read',
  )
}

checkCodec()
checkThreadMessage()
checkOutbox()
checkBox()
checkDesktopCsp()
checkGrid()
checkOutsideRequests()
await checkKlipy()
await checkTimeout()

if (failures.length) {
  console.error(`GIF check failed, ${failures.length} of ${checks}:`)
  for (const failure of failures.slice(0, 40)) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`GIF check passed, ${checks} checks.`)

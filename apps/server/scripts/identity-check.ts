import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

process.env.TRUSTED_ORIGINS = ''
const { config, origins } = await import('../src/lib/config')
const { contextAllowed, readAttestation, upgradeHeaders } = await import('../src/lib/identity')

const host = new URL(config.SERVER_URL).host
const websocketHost = new URL(config.WS_PUBLIC_URL).host
const served = { host, 'tailscale-user-login': 'ada@example.com' }
const none = (reason: string) => ({ kind: 'no-identity', reason })
const person = (login: string, suggestedName: string) => ({ kind: 'person', login, suggestedName })

const table: [string, Record<string, string>, unknown][] = [
  [
    'Serve with login and name',
    { ...served, 'tailscale-user-name': 'Ada Lovelace' },
    person('ada@example.com', 'Ada Lovelace'),
  ],
  ['the WebSocket host', { ...served, host: websocketHost }, person('ada@example.com', 'ada')],
  [
    'a Q-encoded name',
    { ...served, 'tailscale-user-name': '=?utf-8?q?Jos=C3=A9_Garc=C3=ADa?=' },
    person('ada@example.com', 'José García'),
  ],
  [
    'a long name split into several encoded words',
    {
      ...served,
      'tailscale-user-name':
        '=?utf-8?q?=E6=97=A5=E6=9C=AC=E8=AA=9E=E6=97=A5=E6=9C=AC=E8=AA=9E=E6=97=A5?= =?utf-8?q?=E6=9C=AC=E8=AA=9E?=',
    },
    person('ada@example.com', '日本語日本語日本語'),
  ],
  [
    'an empty name falls back to the login',
    { ...served, 'tailscale-user-name': '' },
    person('ada@example.com', 'ada'),
  ],
  [
    'a name that is not valid UTF-8 falls back to the login',
    { ...served, 'tailscale-user-name': '=?utf-8?q?=FF=FE?=' },
    person('ada@example.com', 'ada'),
  ],
  [
    'a name that is only partly encoded stays as sent',
    { ...served, 'tailscale-user-name': 'Ada =?utf-8?q?=C3=A9?=' },
    person('ada@example.com', 'Ada =?utf-8?q?=C3=A9?='),
  ],
  [
    'a long name is cut to 80 characters',
    { ...served, 'tailscale-user-name': 'x'.repeat(100) },
    person('ada@example.com', 'x'.repeat(80)),
  ],
  [
    'a Q-encoded login',
    { host, 'tailscale-user-login': '=?utf-8?q?jos=C3=A9@example.com?=' },
    person('josé@example.com', 'josé'),
  ],
  [
    'a login keeps its case',
    { host, 'tailscale-user-login': 'Ada@Example.COM' },
    person('Ada@Example.COM', 'Ada'),
  ],
  [
    'a GitHub login',
    { host, 'tailscale-user-login': 'octocat@github' },
    person('octocat@github', 'octocat'),
  ],
  ['Funnel traffic', { ...served, 'tailscale-funnel-request': '?1' }, none('funnel')],
  [
    'Funnel traffic with a wrong Host',
    { host: 'evil.test', 'tailscale-funnel-request': '?1' },
    none('funnel'),
  ],
  ['a wrong Host, as DNS rebinding sends', { ...served, host: 'evil.test' }, none('direct')],
  ['no Host', { 'tailscale-user-login': 'ada@example.com' }, none('direct')],
  ['Serve added nothing: a tagged device', { host, 'x-forwarded-host': host }, none('no-user')],
  ['a loopback caller with no headers', { host }, none('direct')],
  [
    'the underscore header alone',
    { host, tailscale_user_login: 'evil@example.com' },
    none('direct'),
  ],
  [
    'the underscore header beside the real one',
    { ...served, tailscale_user_login: 'evil@example.com' },
    person('ada@example.com', 'ada'),
  ],
  [
    'an empty login means invalid UTF-8',
    { host, 'tailscale-user-login': '', 'x-forwarded-host': host },
    none('no-user'),
  ],
  [
    'an undecodable login',
    { host, 'tailscale-user-login': '=?utf-8?q?=FF@example.com?=', 'x-forwarded-host': host },
    none('no-user'),
  ],
  ['a login with no at sign', { host, 'tailscale-user-login': 'ada' }, none('direct')],
  [
    'a doubled login header, as Node joins it',
    { host, 'tailscale-user-login': 'ada@example.com, evil@example.com' },
    none('direct'),
  ],
  [
    'a login with a space',
    { host, 'tailscale-user-login': 'ada lovelace@example.com' },
    none('direct'),
  ],
  [
    'a login over 320 characters',
    { host, 'tailscale-user-login': `${'a'.repeat(320)}@example.com` },
    none('direct'),
  ],
]
for (const [label, headers, expected] of table)
  assert.deepEqual(readAttestation(new Headers(headers)), expected, label)
assert.deepEqual(
  readAttestation(
    upgradeHeaders({ host, 'tailscale-user-login': 'ada@example.com, evil@example.com' }),
  ),
  none('direct'),
  'an upgrade with a doubled login carries no identity',
)
assert.deepEqual(
  readAttestation(upgradeHeaders({ ...served, 'x-other': ['a', 'b'], absent: undefined })),
  person('ada@example.com', 'ada'),
  'upgrade headers convert repeated and absent values',
)

const trusted = config.SERVER_URL
assert.ok(origins.has('tauri://localhost') && origins.has('https://tauri.localhost'))
assert.ok(!origins.has('http://tauri.localhost'), 'the plain http Tauri origin is not trusted')
assert.ok(!origins.has('null'), 'the opaque origin is never trusted')
const contexts: [string, Record<string, string>, 'read' | 'write', boolean][] = [
  ['an allowed page reads', { origin: trusted }, 'read', true],
  ['an allowed page writes', { origin: trusted }, 'write', true],
  ['a cross-site page cannot read', { origin: 'https://evil.test' }, 'read', false],
  ['a cross-site page cannot write', { origin: 'https://evil.test' }, 'write', false],
  ['an opaque origin cannot write', { origin: 'null' }, 'write', false],
  ['a write without an origin', {}, 'write', false],
  ['a same-origin GET without an origin', { 'sec-fetch-site': 'same-origin' }, 'read', true],
  ['a typed address', { 'sec-fetch-site': 'none' }, 'read', true],
  ['a client that sends no fetch metadata', {}, 'read', true],
  ['a cross-site image', { 'sec-fetch-site': 'cross-site' }, 'read', false],
  ['another port of this host', { 'sec-fetch-site': 'same-site' }, 'read', false],
]
for (const [label, headers, intent, allowed] of contexts)
  assert.equal(contextAllowed(new Headers(headers), intent), allowed, label)
process.stdout.write(
  `PASS the header table covers ${table.length} requests and the context rule covers ${contexts.length}.\n`,
)

function configFor(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "const { config, origins, serverHosts } = await import('./src/lib/config.ts'); process.stdout.write(JSON.stringify({ websocket: config.WS_PUBLIC_URL, age: config.SOCKET_MAX_AGE_SECONDS, origins: [...origins], hosts: [...serverHosts], voice: config.voice, gifs: config.gifs }))",
    ],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: 'postgresql://huddle:unused@localhost/unused',
        SERVER_URL: 'https://huddle.tailnet.ts.net',
        ...env,
      },
    },
  )
}
const hosted = configFor({})
assert.equal(hosted.status, 0, hosted.stderr)
assert.deepEqual(JSON.parse(hosted.stdout), {
  websocket: 'wss://huddle.tailnet.ts.net/events',
  age: 300,
  origins: ['https://huddle.tailnet.ts.net', 'tauri://localhost', 'https://tauri.localhost'],
  hosts: ['huddle.tailnet.ts.net'],
  voice: null,
  gifs: null,
})
for (const [entry, reason] of [
  ['http://localhost:1420', 'plain HTTP'],
  ['http://chat.example.com', 'plain HTTP'],
  ['https://localhost:1420', 'loopback'],
  ['https://tools.localhost', 'loopback'],
  ['https://127.0.0.1:8443', 'loopback'],
  ['https://[::1]:8443', 'loopback'],
  ['*', 'not an origin'],
] as const) {
  const refused = configFor({ TRUSTED_ORIGINS: `https://chat.example.com,${entry}` })
  assert.notEqual(refused.status, 0, `${entry} is refused on an HTTPS server`)
  assert.match(refused.stderr, new RegExp(`must not list ${entry.replace(/[*[\]]/g, '\\$&')}`))
  assert.match(refused.stderr, new RegExp(reason), `the refusal for ${entry} says why`)
}
assert.equal(configFor({ TRUSTED_ORIGINS: 'https://chat.example.com,tauri://localhost' }).status, 0)
const insecureSocket = configFor({ WS_PUBLIC_URL: 'ws://huddle.tailnet.ts.net/events' })
assert.notEqual(insecureSocket.status, 0)
assert.match(insecureSocket.stderr, /requires a wss:/)
assert.equal(
  configFor({ SERVER_URL: 'http://localhost:3000', TRUSTED_ORIGINS: 'http://localhost:1420' })
    .status,
  0,
  'development may trust its own frontend',
)
assert.notEqual(configFor({ SERVER_URL: 'http://huddle.example.com' }).status, 0)
process.stdout.write('PASS config refuses unsafe origins on an HTTPS server and says why.\n')

const secret = 's'.repeat(32)
const local = { SERVER_URL: 'http://localhost:3000' }
const voiceCases: [string, Record<string, string>, unknown][] = [
  ['no secret means no voice', {}, null],
  ['an empty secret means no voice', { LIVEKIT_API_SECRET: '' }, null],
  [
    'an HTTPS server defaults to its own name on 8443',
    { LIVEKIT_API_SECRET: secret },
    {
      key: 'huddle',
      secret,
      url: 'wss://huddle.tailnet.ts.net:8443',
      adminUrl: 'http://127.0.0.1:7880',
    },
  ],
  [
    'the default drops the port of SERVER_URL',
    { LIVEKIT_API_SECRET: secret, SERVER_URL: 'https://huddle.tailnet.ts.net:10000' },
    {
      key: 'huddle',
      secret,
      url: 'wss://huddle.tailnet.ts.net:8443',
      adminUrl: 'http://127.0.0.1:7880',
    },
  ],
  [
    'a local server defaults to port 7880',
    { LIVEKIT_API_SECRET: secret, ...local },
    { key: 'huddle', secret, url: 'ws://localhost:7880', adminUrl: 'http://127.0.0.1:7880' },
  ],
  [
    "a local server follows this checkout's port",
    { LIVEKIT_API_SECRET: secret, LIVEKIT_PORT: '17880', ...local },
    { key: 'huddle', secret, url: 'ws://localhost:17880', adminUrl: 'http://127.0.0.1:17880' },
  ],
  [
    'an explicit key and address win',
    {
      LIVEKIT_API_SECRET: secret,
      LIVEKIT_API_KEY: 'other',
      LIVEKIT_PUBLIC_URL: 'wss://voice.tailnet.ts.net',
    },
    { key: 'other', secret, url: 'wss://voice.tailnet.ts.net', adminUrl: 'http://127.0.0.1:7880' },
  ],
]
for (const [label, env, voice] of voiceCases) {
  const result = configFor(env)
  assert.equal(result.status, 0, `${label}: ${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout).voice, voice, label)
}
assert.deepEqual(
  JSON.parse(configFor({ LIVEKIT_API_SECRET: secret }).stdout).hosts,
  ['huddle.tailnet.ts.net'],
  'the LiveKit address never counts as a Huddle address',
)
const voiceRefusals: [string, Record<string, string>, RegExp][] = [
  ['a short secret', { LIVEKIT_API_SECRET: 'short-secret' }, /LIVEKIT_API_SECRET/],
  [
    'plain ws on an HTTPS server',
    { LIVEKIT_API_SECRET: secret, LIVEKIT_PUBLIC_URL: 'ws://huddle.tailnet.ts.net:8443' },
    /requires a wss: LIVEKIT_PUBLIC_URL/,
  ],
  [
    'plain ws on an HTTPS server with voice off',
    { LIVEKIT_PUBLIC_URL: 'ws://huddle.tailnet.ts.net:8443' },
    /requires a wss: LIVEKIT_PUBLIC_URL/,
  ],
  [
    'an address that is not a WebSocket',
    { LIVEKIT_API_SECRET: secret, LIVEKIT_PUBLIC_URL: 'https://huddle.tailnet.ts.net:8443' },
    /LIVEKIT_PUBLIC_URL/,
  ],
]
for (const [label, env, reason] of voiceRefusals) {
  const refused = configFor(env)
  assert.notEqual(refused.status, 0, `${label} is refused`)
  assert.match(refused.stderr, reason, `the refusal for ${label} says why`)
  assert.doesNotMatch(refused.stderr, /short-secret/, 'a refusal never prints the secret')
}
process.stdout.write(
  `PASS voice config covers ${voiceCases.length} settings and ${voiceRefusals.length} refusals.\n`,
)

const appKey = 'Klipy-key_0.9~'
const gifCases: [string, Record<string, string>, unknown][] = [
  ['no key means no GIFs', {}, null],
  ['an empty key means no GIFs', { KLIPY_APP_KEY: '' }, null],
  ['the filter defaults to medium', { KLIPY_APP_KEY: appKey }, { appKey, contentFilter: 'medium' }],
  [
    'an empty filter means medium',
    { KLIPY_APP_KEY: appKey, KLIPY_CONTENT_FILTER: '' },
    { appKey, contentFilter: 'medium' },
  ],
  ...(['off', 'low', 'medium', 'high'] as const).map(
    (contentFilter) =>
      [
        `the ${contentFilter} filter`,
        { KLIPY_APP_KEY: appKey, KLIPY_CONTENT_FILTER: contentFilter },
        { appKey, contentFilter },
      ] as [string, Record<string, string>, unknown],
  ),
  ['a filter with no key is ignored', { KLIPY_CONTENT_FILTER: 'high' }, null],
]
for (const [label, env, gifs] of gifCases) {
  const result = configFor(env)
  assert.equal(result.status, 0, `${label}: ${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout).gifs, gifs, label)
}
const gifRefusals: [string, Record<string, string>, RegExp][] = [
  ['a key with a slash', { KLIPY_APP_KEY: 'leaked/key' }, /KLIPY_APP_KEY/],
  ['a key with a space', { KLIPY_APP_KEY: 'leaked key' }, /KLIPY_APP_KEY/],
  ['a key longer than 256 characters', { KLIPY_APP_KEY: 'k'.repeat(257) }, /KLIPY_APP_KEY/],
  [
    'an unknown filter',
    { KLIPY_APP_KEY: appKey, KLIPY_CONTENT_FILTER: 'strict' },
    /KLIPY_CONTENT_FILTER/,
  ],
]
for (const [label, env, reason] of gifRefusals) {
  const refused = configFor(env)
  assert.notEqual(refused.status, 0, `${label} is refused`)
  assert.match(refused.stderr, reason, `the refusal for ${label} says why`)
  assert.doesNotMatch(refused.stderr, /leaked/, 'a refusal never prints the key')
}
process.stdout.write(
  `PASS GIF config covers ${gifCases.length} settings and ${gifRefusals.length} refusals.\n`,
)

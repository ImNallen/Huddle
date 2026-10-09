import assert from 'node:assert/strict'

const app = process.env.HUDDLE_PROBE_URL ?? 'http://localhost:3000'
const issuer = process.env.OIDC_FIXTURE_ISSUER ?? 'http://127.0.0.1:3174'
const modes = [
  'missing_id_token',
  'wrong_issuer',
  'wrong_audience',
  'missing_email_verified',
  'unverified_email',
  'wrong_nonce',
  'missing_sub',
  'userinfo_subject_mismatch',
  'valid',
]

class BrowserSession {
  cookies = new Map()
  async get(url) {
    return this.request(url)
  }
  async request(url, body) {
    const headers = { origin: new URL(app).origin }
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(new URL(url, app), {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]
      const index = pair.indexOf('=')
      if (index >= 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    let data
    const text = await response.text()
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { status: response.status, data, location: response.headers.get('location') }
  }
}

for (const mode of modes) {
  const changed = await fetch(`${issuer}/__fixture/mode`, {
    method: 'POST',
    body: new URLSearchParams({ mode }),
  })
  assert.equal(changed.status, 200, 'OIDC fixture unavailable')
  const client = new BrowserSession()
  const start = await client.request('/api/auth/sign-in/oauth2', {
    providerId: 'company',
    callbackURL: '/',
  })
  assert.equal(start.status, 200, `OIDC start failed for ${mode} with status ${start.status}`)
  assert.ok(start.data?.url)
  const authorization = new URL(start.data.url)
  assert.equal(authorization.origin, issuer)
  const page = await fetch(authorization)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Sign in and approve/)
  const consent = await fetch(authorization, {
    method: 'POST',
    body: new URLSearchParams([...authorization.searchParams, ['decision', 'approve']]),
    redirect: 'manual',
  })
  assert.equal(consent.status, 302)
  let callback = consent.headers.get('location')
  for (let redirects = 0; redirects < 5; redirects++) {
    const result = await client.get(callback)
    if (result.status < 300 || result.status >= 400 || !result.location) break
    callback = result.location
  }
  const access = await client.get('/api/access')
  if (mode === 'valid' || mode === 'userinfo_subject_mismatch') {
    assert.equal(access.status, 200)
    assert.ok(
      ['passkey-offer', 'profile', 'ready'].includes(access.data?.stage?.kind),
      `valid ID token did not admit provider sign-in; stage ${access.data?.stage?.kind ?? 'none'}`,
    )
    let view = access
    if (view.data.stage.kind === 'passkey-offer') {
      view = await client.request('/api/access', { kind: 'passkey.skip' })
      assert.equal(view.status, 200)
    }
    if (view.data.stage.kind === 'profile') {
      view = await client.request('/api/access', {
        kind: 'profile.save',
        profile: {
          name: 'Fixture Colleague',
          avatar: { kind: 'mascot', shape: 'square', color: 'indigo' },
        },
      })
      assert.equal(view.status, 200)
    }
    assert.equal(view.data.stage.kind, 'ready')
    assert.equal(view.data.stage.user.email, 'oidc-fixture@huddle.test')
    assert.equal((await client.get('/api/workspaces')).status, 200)
    assert.equal((await client.get('/api/account')).status, 200)
    console.log(
      mode === 'valid'
        ? 'PASS OIDC verified ID token and completed profile admit account/workspace'
        : 'PASS unused userinfo cannot change the verified ID-token identity',
    )
  } else {
    assert.equal(access.status, 200)
    assert.equal(access.data?.stage?.kind, 'signin', `${mode} unexpectedly admitted`)
    const account = await client.get('/api/account')
    assert.ok(
      account.status === 401 || account.status === 403,
      `${mode} accessed account with status ${account.status}`,
    )
    const workspace = await client.get('/api/workspaces')
    assert.ok(
      workspace.status === 401 || workspace.status === 403,
      `${mode} accessed workspace with status ${workspace.status}`,
    )
    console.log(`PASS OIDC ${mode} refused by public APIs`)
  }
}
await fetch(`${issuer}/__fixture/mode`, {
  method: 'POST',
  body: new URLSearchParams({ mode: 'valid' }),
})

import { randomUUID } from 'node:crypto'
import { expect, test, type Page, type Response } from '@playwright/test'
import { tailscale } from '../apps/server/scripts/harness'
import { Channel, PhotoUpload, Room } from '../packages/contracts/src/index'
import { browserApp, expectHome, loginOf, serverURL } from './accounts'
import { useScratchServer, websocketURL } from './server'

const server = useScratchServer('api')
const evil = 'http://evil.test'
const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=='

async function evilPage(page: Page) {
  await page.route(`${evil}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Not Huddle</title>' }),
  )
  await page.route(`${serverURL}/**`, (route) => route.continue())
  await page.goto(`${evil}/`)
  return (pathname: string) =>
    page.waitForResponse(
      (response: Response) =>
        response.url().startsWith(serverURL) && new URL(response.url()).pathname === pathname,
    )
}

test.describe('a page from another site, in a browser that has an identity', () => {
  test.use({ extraHTTPHeaders: tailscale(loginOf('uiadmin')) })
  test.setTimeout(30000)

  test('the same identity works for Huddle itself, over HTTP and the socket', async ({ page }) => {
    await page.goto(browserApp)
    await expectHome(page)
    await expect(page.getByRole('status')).toHaveText('Connected')
  })

  test('fetch can neither read nor write', async ({ page }) => {
    const answer = await evilPage(page)
    const readable = await page.evaluate(
      (url) =>
        fetch(`${url}/api/snapshot`).then(
          () => 'read',
          () => 'refused',
        ),
      serverURL,
    )
    expect(readable).toBe('refused')

    const opaque = answer('/api/snapshot')
    await page.evaluate(
      (url) => fetch(`${url}/api/snapshot`, { mode: 'no-cors', credentials: 'omit' }),
      serverURL,
    )
    expect((await opaque).status()).toBe(403)

    const name = `From evil ${randomUUID()}`
    const write = answer('/api/rooms')
    await page.evaluate(
      ({ url, name }) =>
        fetch(`${url}/api/rooms`, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ name }),
        }),
      { url: serverURL, name },
    )
    expect((await write).status()).toBe(403)
    const rooms = await server.admin.call('/api/snapshot')
    expect(JSON.stringify(rooms.value)).not.toContain(name)
  })

  test('an image cannot load a photo the identity can see', async ({ page }) => {
    const form = new FormData()
    form.set(
      'photo',
      new File([Buffer.from(onePixelPng, 'base64')], 'a.png', { type: 'image/png' }),
    )
    const uploaded = await fetch(`${serverURL}/api/account/photo`, {
      method: 'POST',
      headers: {
        Origin: serverURL,
        'X-Huddle-User': server.admin.userId ?? '',
        ...tailscale(loginOf('uiadmin')),
      },
      body: form,
    })
    expect(uploaded.status).toBe(200)
    const { uploadId } = PhotoUpload.parse(await uploaded.json())
    const loads = (src: string) =>
      new Promise<boolean>((resolve) => {
        const image = document.createElement('img')
        image.onload = () => resolve(true)
        image.onerror = () => resolve(false)
        image.src = src
        document.body.append(image)
      })
    const src = `${serverURL}/api/account/photo/${uploadId}`
    await page.goto(browserApp)
    await expectHome(page)
    expect(await page.evaluate(loads, src)).toBe(true)
    await evilPage(page)
    expect(await page.evaluate(loads, src)).toBe(false)
  })

  test('a form cannot post a message', async ({ page }) => {
    const room = Room.parse((await server.admin.call('/api/rooms', { name: 'Forms' })).value)
    const channel = Channel.parse(
      (
        await server.admin.call('/api/channels', {
          roomId: room.id,
          name: 'posted',
          kind: 'text',
        })
      ).value,
    )
    const answer = await evilPage(page)
    const body = `Posted by a form ${randomUUID()}`
    const posted = answer('/api/messages')
    await page.evaluate(
      ({ url, channelId, retryId, body }) => {
        const form = document.createElement('form')
        form.method = 'POST'
        form.enctype = 'text/plain'
        form.action = `${url}/api/messages`
        const input = document.createElement('input')
        input.name = JSON.stringify({ channelId, retryId, body }).slice(0, -1) + ',"x":"'
        input.value = '"}'
        form.append(input)
        document.body.append(form)
        form.submit()
      },
      { url: serverURL, channelId: channel.id, retryId: randomUUID(), body },
    )
    expect((await posted).status()).toBe(403)
    const history = await server.admin.call(`/api/messages?channelId=${channel.id}`)
    expect(history.value).toEqual([])
  })

  test('a WebSocket is refused by the server before it opens', async ({ page }) => {
    await evilPage(page)
    const refusal = new Promise<string>((resolve) =>
      page.on('websocket', (socket) => socket.on('socketerror', resolve)),
    )
    const outcome = await page.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(url)
          socket.onopen = () => {
            socket.close()
            resolve('open')
          }
          socket.onerror = () => resolve('refused')
        }),
      websocketURL,
    )
    expect(outcome).toBe('refused')
    expect(await refusal).toContain('403')
  })

  test('another page cannot frame the app', async ({ page }) => {
    await evilPage(page)
    const framed = page.waitForResponse(browserApp)
    await page.evaluate((url) => {
      const frame = document.createElement('iframe')
      frame.src = url
      document.body.append(frame)
    }, browserApp)
    const response = await framed
    expect(response.headers()['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(response.headers()['x-frame-options']).toBe('DENY')
    await page.waitForTimeout(500)
    const child = page.frames().find((frame) => frame !== page.mainFrame())
    expect(child?.url()).not.toBe(browserApp)
    expect(await child?.locator('.access-shell, .app').count()).toBe(0)
  })
})

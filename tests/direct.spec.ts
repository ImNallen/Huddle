import { expect, test, type Page } from '@playwright/test'
import { apiPost, inviteCode, join, onboard, rail, railTile, serverURL } from './accounts'
import { useScratchServer } from './server'

useScratchServer('ui')

const serverTitle = 'Harbor'
const sidebar = (page: Page) => page.getByRole('navigation', { name: serverTitle, exact: true })
const directRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name}`) })
const homeRow = (page: Page, name: string) =>
  page.getByRole('main').getByRole('button', { name: new RegExp(`^${name}`) })
const composer = (page: Page, name: string) =>
  page.getByRole('textbox', { name: `Message @${name}`, exact: true })
async function send(page: Page, peer: string, body: string) {
  await composer(page, peer).fill(body)
  await page.getByRole('button', { name: 'Send message' }).click()
}
async function expectNoTrace(page: Page, secrets: string[]) {
  await expect(railTile(page, 'Home')).toHaveAccessibleDescription('')
  await expect(rail(page).locator('.rail-count')).toHaveCount(0)
  await expect(sidebar(page)).toContainText('No messages yet.')
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'No messages yet' }),
  ).toBeVisible()
  for (const secret of secrets) await expect(page.locator('body')).not.toContainText(secret)
}

test('direct messages reach the two people in them and nobody else', async ({ browser, page }) => {
  const avery = page
  const jonasContext = await browser.newContext()
  const miraContext = await browser.newContext()
  const jonas = await jonasContext.newPage()
  const mira = await miraContext.newPage()
  const first = `Private note ${crypto.randomUUID()}`
  const reply = `Private reply ${crypto.randomUUID()}`
  try {
    await onboard(avery, 'avery', serverTitle)
    const room = await apiPost(avery, '/api/rooms', { name: 'Lounge' })
    const channel = await apiPost(avery, '/api/channels', {
      roomId: room.id,
      name: 'general',
      kind: 'text',
    })
    const code = await inviteCode(avery)
    await join(jonas, 'jonas', code)
    await join(mira, 'mira', code)
    await avery.reload()
    await expect(
      avery.getByRole('heading', { name: /^Good (morning|afternoon|evening), avery/ }),
    ).toBeVisible()

    await expect(
      avery.getByRole('main').getByRole('heading', { name: 'No messages yet' }),
    ).toBeVisible()
    await expect(sidebar(avery)).toContainText('Direct messages')
    await expect(sidebar(avery)).toContainText('No messages yet.')
    await avery.getByRole('button', { name: 'Member list', exact: true }).click()
    const memberPanel = avery.getByRole('list', { name: 'Members' })
    await expect(memberPanel.getByRole('button', { name: 'Message avery' })).toHaveCount(0)
    await expect(memberPanel.getByText('avery', { exact: true })).toBeVisible()

    await memberPanel.getByRole('button', { name: 'Message jonas', exact: true }).click()
    const thread = avery.getByRole('main')
    await expect(
      thread.getByRole('heading', { level: 1, name: 'jonas', exact: true }),
    ).toBeVisible()
    await expect(thread.locator('.topbar')).toHaveText('jonas')
    await expect(
      thread.getByText('This is the start of your conversation with jonas.', { exact: true }),
    ).toBeVisible()
    await expect(
      thread.getByText(
        'Messages are stored on this server unencrypted, so its host could read them.',
        {
          exact: true,
        },
      ),
    ).toBeVisible()
    await expect(composer(avery, 'jonas')).toHaveAttribute('placeholder', 'Message @jonas')
    await expect(memberPanel).toHaveCount(0)
    await expect(avery.getByRole('button', { name: 'Member list', exact: true })).toHaveCount(0)
    await expect(directRow(avery, 'jonas')).toHaveAttribute('aria-current', 'page')

    await jonas.waitForTimeout(500)
    await expectNoTrace(jonas, [])
    await expectNoTrace(mira, [])

    await send(avery, 'jonas', first)
    await expect(thread.getByText(first, { exact: true })).toBeVisible()
    await expect(railTile(jonas, 'Home')).toHaveAccessibleDescription('1 unread')
    await expect(railTile(jonas, 'Home').locator('.rail-count')).toHaveText('1')
    await expect(directRow(jonas, 'avery')).toHaveAccessibleName('avery 1 unread')
    const preview = homeRow(jonas, 'avery')
    await expect(preview).toContainText(first)
    await expect(preview).toContainText('1 new')
    await expectNoTrace(mira, [first])

    const jonasRead = jonas.waitForResponse('**/api/direct/read')
    await preview.click()
    await expect(jonas.getByRole('heading', { level: 1, name: 'avery', exact: true })).toBeVisible()
    await expect(jonas.getByText(first, { exact: true })).toBeVisible()
    await jonasRead
    await expect(railTile(jonas, 'Home')).toHaveAccessibleDescription('')
    await expect(railTile(jonas, 'Home').locator('.rail-count')).toHaveCount(0)
    await expect(directRow(jonas, 'avery')).toHaveAccessibleName('avery')

    const averyRead = avery.waitForResponse('**/api/direct/read')
    await send(jonas, 'avery', reply)
    await expect(avery.getByText(reply, { exact: true })).toBeVisible()
    await averyRead
    await expect(railTile(avery, 'Home')).toHaveAccessibleDescription('')
    await railTile(jonas, 'Home').click()
    await expect(homeRow(jonas, 'avery')).toContainText(`You: ${reply}`)
    await expect(homeRow(jonas, 'avery')).not.toContainText('new')
    await expectNoTrace(mira, [first, reply])

    await avery.reload()
    await expect(homeRow(avery, 'jonas')).toContainText(reply)
    await expect(railTile(avery, 'Home')).toHaveAccessibleDescription('')
    await directRow(avery, 'jonas').click()
    await expect(avery.getByText(first, { exact: true })).toBeVisible()
    await expect(avery.getByText(reply, { exact: true })).toBeVisible()
    await mira.reload()
    await expect(
      mira.getByRole('main').getByRole('heading', { name: 'No messages yet' }),
    ).toBeVisible()
    await expectNoTrace(mira, [first, reply])

    await mira.getByRole('main').getByRole('button', { name: 'New message', exact: true }).click()
    const dialog = mira.getByRole('dialog', { name: 'New message' })
    await expect(dialog.getByRole('button', { name: 'avery', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'mira', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'jonas', exact: true }).click()
    await expect(mira.getByRole('dialog')).toHaveCount(0)
    await expect(mira.getByRole('heading', { level: 1, name: 'jonas', exact: true })).toBeVisible()
    await send(mira, 'jonas', 'Are we still on for tonight?')
    await expect(railTile(jonas, 'Home')).toHaveAccessibleDescription('1 unread')
    await expect(homeRow(jonas, 'mira')).toContainText('Are we still on for tonight?')
    await expect(directRow(avery, 'mira')).toHaveCount(0)
    await expect(avery.locator('body')).not.toContainText('Are we still on for tonight?')

    const attempts: string[] = []
    await jonas.route('**/api/direct/messages', async (route) => {
      if (route.request().method() === 'POST') {
        attempts.push(route.request().postData() ?? '')
        await route.abort('connectionfailed')
      } else await route.continue()
    })
    await directRow(jonas, 'mira').click()
    await send(jonas, 'mira', 'Keep this through a restart.')
    await expect(jonas.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await jonas.reload()
    await directRow(jonas, 'mira').click()
    await expect(jonas.getByText('Keep this through a restart.', { exact: true })).toBeVisible()
    await jonas.unroute('**/api/direct/messages')
    jonas.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/direct/messages'))
        attempts.push(request.postData() ?? '')
    })
    await jonas.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(mira.getByText('Keep this through a restart.', { exact: true })).toBeVisible()
    await expect(jonas.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])

    await sidebar(avery).getByRole('button', { name: 'New message', exact: true }).click()
    await avery
      .getByRole('dialog', { name: 'New message' })
      .getByRole('button', { name: 'mira', exact: true })
      .click()
    await avery.route('**/api/direct/messages', async (route) => {
      if (route.request().method() === 'POST') await route.abort('connectionfailed')
      else await route.continue()
    })
    await send(avery, 'mira', 'The first message in a new conversation.')
    await expect(avery.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await avery.reload()
    await directRow(avery, 'mira').click()
    await expect(
      avery.getByText('The first message in a new conversation.', { exact: true }),
    ).toBeVisible()
    await avery.unroute('**/api/direct/messages')
    await avery.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(railTile(mira, 'Home')).toHaveAccessibleDescription('1 unread')
    await expect(directRow(mira, 'avery')).toBeVisible()

    const body = 'Written before direct messages existed.'
    await avery.evaluate(
      async ({ serverURL, channelId, body }) => {
        const access = await fetch('/api/access')
        const stage = (await access.json()) as { user: { id: string } }
        localStorage.setItem(
          `huddle.outbox:${serverURL}:${stage.user.id}`,
          JSON.stringify([
            { channelId, retryId: crypto.randomUUID(), body, kind: 'failed', error: 'Stored' },
          ]),
        )
      },
      { serverURL, channelId: channel.id, body },
    )
    await avery.reload()
    await railTile(avery, 'Lounge').click()
    await expect(avery.getByText(body, { exact: true })).toBeVisible()
    await avery.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(avery.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    await railTile(mira, 'Lounge').click()
    await expect(mira.getByText(body, { exact: true })).toBeVisible()
  } finally {
    await jonasContext.close()
    await miraContext.close()
  }
})

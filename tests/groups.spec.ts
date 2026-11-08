import { expect, test, type Page } from '@playwright/test'
import {
  Room,
  GroupObservation,
  GroupMessage,
  Snapshot,
  AccessStage,
  type GroupConversation,
} from '../packages/contracts/src/index'
import { apiPost, member, railTile, serverURL } from './accounts'
import { useScratchServer } from './server'
import { Client } from '../apps/server/scripts/harness'

const fixture = useScratchServer('api')
async function joinNamed(page: Page, name: string) {
  await member(fixture.admin, page, name.toLowerCase().replace(/\s+/g, ''))
  const user = await who(page)
  await apiPost(page, '/api/access', {
    kind: 'profile.save',
    profile: { name, avatar: user.avatar },
  })
  await page.reload()
}
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Huddle UI', exact: true })
const row = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name}`) })
async function who(page: Page) {
  const stage = AccessStage.parse(
    await page.evaluate(async () => (await fetch('/api/access')).json()),
  )
  if (stage.kind !== 'ready') throw new Error('Not ready')
  return stage.user
}
const grant = (group: GroupConversation, id: string) => ({
  groupId: group.id,
  admission: group.members.find((m) => m.userId === id)?.admission,
})
async function groupOf(page: Page, name: string) {
  const snapshot = Snapshot.parse(
    await page.evaluate(async () => (await fetch('/api/snapshot')).json()),
  )
  const group = snapshot.groups.find((g) => g.name === name)
  if (!group) throw new Error('Missing group')
  return group
}
async function capture(page: Page, name: string) {
  await page.screenshot({ path: `test-results/${name}.png`, animations: 'disabled' })
}
async function send(page: Page, name: string, body: string) {
  await page.getByRole('textbox', { name: `Message ${name}`, exact: true }).fill(body)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('main').getByText(body, { exact: true })).toBeVisible()
}

async function holdRequest(
  page: Page,
  url: string,
  mode: 'response' | 'failure' | 'aborted-history' = 'response',
) {
  let ready = () => {},
    resume = () => {},
    done = () => {}
  const held = new Promise<void>((resolve) => (ready = resolve))
  const resumed = new Promise<void>((resolve) => (resume = resolve))
  const finished = new Promise<void>((resolve) => (done = resolve))
  await page.route(
    url,
    async (route) => {
      const result = mode === 'failure' ? null : await route.fetch()
      const body = result ? await result.body() : null
      ready()
      await resumed
      try {
        if (result && body)
          await route.fulfill({ status: result.status(), headers: result.headers(), body })
        else await route.abort()
      } catch (error) {
        if (mode !== 'aborted-history') throw error
      } finally {
        done()
      }
    },
    { times: 1 },
  )
  return {
    held,
    release: async () => {
      resume()
      await finished
    },
  }
}

test('groups match both themes and support live messages, adding people and leaving', async ({
  browser,
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ])
  const [maya, jonas, leah, outsider] = await Promise.all(
    contexts.map((context) => context.newPage()),
  )
  if (!maya || !jonas || !leah || !outsider) throw new Error('Missing page')
  try {
    await joinNamed(page, 'Avery')
    await joinNamed(maya, 'Maya Lind')
    await joinNamed(jonas, 'Jonas Berg')
    await joinNamed(leah, 'Leah Chen')
    await joinNamed(outsider, 'Dee')
    // Complete the existing Home setup so group previews are also visible there.
    const room = await fixture.admin.call('/api/rooms', { name: 'Lounge' })
    const roomId = Room.parse(room.value).id
    await fixture.admin.call('/api/channels', { roomId, name: 'general', kind: 'text' })
    await page.reload()
    await sidebar(page).getByRole('button', { name: 'New message', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'New message', exact: true })
      .getByRole('button', { name: 'New group', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: 'New group', exact: true })
    await dialog.getByLabel('Group name').fill('Weekend plans')
    await dialog.getByRole('checkbox', { name: 'Maya Lind', exact: true }).check()
    await dialog.getByRole('checkbox', { name: 'Jonas Berg', exact: true }).check()
    await dialog.getByRole('checkbox', { name: 'Leah Chen', exact: true }).check()
    await expect(dialog.getByText('3 selected', { exact: true })).toBeVisible()
    await capture(page, 'group-create-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await capture(page, 'group-create-dark')
    await dialog.getByRole('button', { name: 'Create group', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Conversation in Weekend plans', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('main').locator('.direct-person')).toHaveText(
      'Weekend plans4 people',
    )
    await expect(page.getByRole('main').getByText(/^You, /)).toBeVisible()
    await expect(row(maya, 'Weekend plans')).toBeVisible()
    await send(page, 'Weekend plans', 'Anyone around this weekend?')
    await expect(row(maya, 'Weekend plans')).toContainText('1')
    await row(maya, 'Weekend plans').click()
    await expect(
      maya.getByRole('main').getByText('Anyone around this weekend?', { exact: true }),
    ).toBeVisible()
    await send(maya, 'Weekend plans', 'A slow morning sounds good.')
    await expect(
      page.getByRole('main').getByText('A slow morning sounds good.', { exact: true }),
    ).toBeVisible()
    await capture(page, 'group-chat-dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await capture(page, 'group-chat-light')
    await expect(row(outsider, 'Weekend plans')).toHaveCount(0)
    await expect(outsider.locator('body')).not.toContainText('Anyone around this weekend?')
    await page.getByRole('button', { name: 'Members · 4', exact: true }).click()
    const members = page.getByRole('dialog', { name: 'Weekend plans', exact: true })
    await expect(members.getByText('You', { exact: true })).toBeVisible()
    await capture(page, 'group-members-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await capture(page, 'group-members-dark')
    // While the dialog covers the thread, incoming messages remain unread.
    await send(maya, 'Weekend plans', 'Bring coffee?')
    await expect(row(page, 'Weekend plans')).toContainText('1')
    await members.getByRole('button', { name: 'Add people', exact: true }).click()
    const add = page.getByRole('dialog', { name: 'Add people', exact: true })
    await expect(
      add.getByText('New people can read earlier messages.', { exact: true }),
    ).toBeVisible()
    await add.getByRole('checkbox', { name: 'Dee', exact: true }).check()
    await add.getByRole('button', { name: 'Add people', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Members · 5', exact: true })).toBeVisible()
    await expect(row(outsider, 'Weekend plans')).toBeVisible()
    await row(outsider, 'Weekend plans').click()
    await expect(
      outsider.getByRole('main').getByText('Anyone around this weekend?', { exact: true }),
    ).toBeVisible()
    await outsider
      .getByRole('textbox', { name: 'Message Weekend plans', exact: true })
      .fill('Draft that must disappear')
    await outsider.getByRole('button', { name: 'Members · 5', exact: true }).click()
    await outsider
      .getByRole('dialog', { name: 'Weekend plans', exact: true })
      .getByRole('button', { name: 'Leave group', exact: true })
      .click()
    await expect(row(outsider, 'Weekend plans')).toHaveCount(0)
    await expect(outsider.getByRole('dialog')).toHaveCount(0)
    await expect(outsider.locator('body')).not.toContainText('Draft that must disappear')
    await expect(page.getByRole('button', { name: 'Members · 4', exact: true })).toBeVisible()
    await outsider.reload()
    await expect(row(outsider, 'Weekend plans')).toHaveCount(0)
    await railTile(page, 'Home').click()
    await expect(
      page.getByRole('main').getByRole('button', { name: /Weekend plans/ }),
    ).toContainText('Bring coffee?')
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('departure fences delayed history, sends, failures and persisted outbox across re-add', async ({
  browser,
  page,
}) => {
  const context = await browser.newContext(),
    other = await context.newPage()
  const thirdContext = await browser.newContext(),
    third = await thirdContext.newPage()
  try {
    await joinNamed(page, 'Race A')
    await joinNamed(other, 'Race B')
    await joinNamed(third, 'Race C')
    const a = await who(page),
      b = await who(other),
      c = await who(third)
    const created = GroupObservation.parse(
      await apiPost(page, '/api/groups', {
        name: 'Race group',
        retryId: crypto.randomUUID(),
        others: [b.id, c.id],
      }),
    )
    const group = created.group,
      old = grant(group, b.id)
    GroupMessage.parse(
      await apiPost(page, '/api/group/messages', {
        ...grant(group, a.id),
        retryId: crypto.randomUUID(),
        body: 'Earlier history',
      }),
    )
    await expect(row(other, 'Race group')).toBeVisible()
    const history = await holdRequest(other, '**/api/group/messages?*', 'aborted-history')
    await row(other, 'Race group').click()
    await history.held
    await apiPost(other, '/api/group/leave', old)
    await expect(row(other, 'Race group')).toHaveCount(0)
    const added = GroupObservation.parse(
      await apiPost(page, '/api/group/people', { ...grant(group, a.id), userIds: [b.id] }),
    )
    const fresh = grant(added.group, b.id)
    expect(fresh.admission).not.toBe(old.admission)
    await expect(row(other, 'Race group')).toBeVisible()
    await history.release()
    await expect(
      other.getByRole('textbox', { name: 'Message Race group', exact: true }),
    ).toHaveCount(0)
    // Persist a send captured under the old admission, including an old grant's draft.
    await other.evaluate(
      ({ origin, id, groupId, admission }) =>
        localStorage.setItem(
          `huddle.outbox:${origin}:${id}`,
          JSON.stringify([
            {
              thread: { kind: 'group', id: groupId, admission },
              retryId: crypto.randomUUID(),
              body: 'Stale queued secret',
              kind: 'sending',
            },
          ]),
        ),
      { origin: serverURL, id: b.id, ...old },
    )
    await other.reload()
    await expect(row(other, 'Race group')).toBeVisible()
    await row(other, 'Race group').click()
    await expect(
      other.getByRole('main').getByText('Earlier history', { exact: true }),
    ).toBeVisible()
    await expect(other.locator('body')).not.toContainText('Stale queued secret')
    await expect
      .poll(() =>
        other.evaluate(({ origin, id }) => localStorage.getItem(`huddle.outbox:${origin}:${id}`), {
          origin: serverURL,
          id: b.id,
        }),
      )
      .toBe('[]')
    const outgoing = await holdRequest(other, '**/api/group/messages')
    await other
      .getByRole('textbox', { name: 'Message Race group', exact: true })
      .fill('Delayed acknowledged secret')
    await other.getByRole('button', { name: 'Send message', exact: true }).click()
    await outgoing.held
    // A separate request commits departure while the original send response is held.
    await apiPost(other, '/api/group/leave', fresh)
    await expect(row(other, 'Race group')).toHaveCount(0)
    await apiPost(page, '/api/group/people', { ...grant(group, a.id), userIds: [b.id] })
    await expect(row(other, 'Race group')).toBeVisible()
    await outgoing.release()
    await expect(
      other.getByRole('textbox', { name: 'Message Race group', exact: true }),
    ).toHaveCount(0)
    await expect(other.locator('body')).not.toContainText('Stale queued secret')
    await row(other, 'Race group').click()
    await expect(
      other.getByRole('main').getByText('Delayed acknowledged secret', { exact: true }),
    ).toBeVisible()
    await expect(
      other.getByRole('textbox', { name: 'Message Race group', exact: true }),
    ).toHaveValue('')
    // A failed old send cannot restore an outbox entry after a newer admission arrives.
    const failing = await holdRequest(other, '**/api/group/messages', 'failure')
    await other
      .getByRole('textbox', { name: 'Message Race group', exact: true })
      .fill('Delayed failed secret')
    await other.getByRole('button', { name: 'Send message', exact: true }).click()
    await failing.held
    const beforeFailure = await groupOf(other, 'Race group')
    await apiPost(other, '/api/group/leave', grant(beforeFailure, b.id))
    await expect(row(other, 'Race group')).toHaveCount(0)
    await apiPost(page, '/api/group/people', { ...grant(group, a.id), userIds: [b.id] })
    await expect(row(other, 'Race group')).toBeVisible()
    await failing.release()
    await row(other, 'Race group').click()
    await expect(
      other.getByRole('textbox', { name: 'Message Race group', exact: true }),
    ).toBeVisible()
    await expect(other.locator('body')).not.toContainText('Delayed failed secret')
    // Hold a successful leave answer while another member admits this person again.
    const departure = await holdRequest(other, '**/api/group/leave')
    await other.getByRole('button', { name: 'Members · 3', exact: true }).click()
    await other
      .getByRole('dialog', { name: 'Race group', exact: true })
      .getByRole('button', { name: 'Leave group', exact: true })
      .click()
    await departure.held
    await expect(row(other, 'Race group')).toHaveCount(0)
    await apiPost(page, '/api/group/people', { ...grant(group, a.id), userIds: [b.id] })
    await expect(row(other, 'Race group')).toBeVisible()
    await row(other, 'Race group').click()
    await other
      .getByRole('textbox', { name: 'Message Race group', exact: true })
      .fill('Current membership draft')
    await departure.release()
    await expect(
      other.getByRole('textbox', { name: 'Message Race group', exact: true }),
    ).toHaveValue('Current membership draft')
    // Departure committed elsewhere is reconciled when an offline client reconnects.
    const current = await groupOf(other, 'Race group')
    const bob = new Client(serverURL, 'raceb@huddle.test')
    await bob.stage()
    await context.setOffline(true)
    const departed = await bob.call('/api/group/leave', grant(current, b.id))
    expect(departed.response.status).toBe(200)
    await context.setOffline(false)
    await expect(row(other, 'Race group')).toHaveCount(0)
    await expect(
      other.getByRole('textbox', { name: 'Message Race group', exact: true }),
    ).toHaveCount(0)
    // Even full storage cannot prevent clearing revoked content from memory.
    await apiPost(page, '/api/group/people', { ...grant(group, a.id), userIds: [b.id] })
    await expect(row(other, 'Race group')).toBeVisible()
    await row(other, 'Race group').click()
    await other.route('**/api/group/messages', (route) => route.abort())
    await other
      .getByRole('textbox', { name: 'Message Race group', exact: true })
      .fill('Storage failure secret')
    await other.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(other.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await other.unroute('**/api/group/messages')
    await other.evaluate((key) => {
      const write = Storage.prototype.setItem
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Full', 'QuotaExceededError')
        return write.call(this, name, value)
      }
    }, `huddle.outbox:${serverURL}:${b.id}`)
    const beforeFullStorageLeave = await groupOf(other, 'Race group')
    await apiPost(other, '/api/group/leave', grant(beforeFullStorageLeave, b.id))
    await expect(row(other, 'Race group')).toHaveCount(0)
    await expect(other.locator('body')).not.toContainText('Storage failure secret')
    await apiPost(page, '/api/group/people', { ...grant(group, a.id), userIds: [b.id] })
    await expect(row(other, 'Race group')).toBeVisible()
    await other.reload()
    await row(other, 'Race group').click()
    await expect(
      other.getByRole('textbox', { name: 'Message Race group', exact: true }),
    ).toHaveValue('')
    await expect(other.locator('body')).not.toContainText('Storage failure secret')
    await expect
      .poll(() =>
        other.evaluate((key) => localStorage.getItem(key), `huddle.outbox:${serverURL}:${b.id}`),
      )
      .toBe('[]')
    // A delayed create answer cannot open the creator's ended admission.
    const creation = await holdRequest(page, '**/api/groups')
    await sidebar(page).getByRole('button', { name: 'New message', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'New message', exact: true })
      .getByRole('button', { name: 'New group', exact: true })
      .click()
    const create = page.getByRole('dialog', { name: 'New group', exact: true })
    await create.getByLabel('Group name').fill('Late create')
    await create.getByRole('checkbox', { name: 'Race B', exact: true }).check()
    await create.getByRole('checkbox', { name: 'Race C', exact: true }).check()
    await create.getByRole('button', { name: 'Create group', exact: true }).click()
    await creation.held
    const late = await groupOf(page, 'Late create')
    await expect(row(page, 'Late create')).toBeVisible()
    await apiPost(page, '/api/group/leave', grant(late, a.id))
    await expect(row(page, 'Late create')).toHaveCount(0)
    await apiPost(third, '/api/group/people', { ...grant(late, c.id), userIds: [a.id] })
    await expect(row(page, 'Late create')).toBeVisible()
    await creation.release()
    await expect(page.getByRole('dialog', { name: 'New group', exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('textbox', { name: 'Message Late create', exact: true }),
    ).toHaveCount(0)
  } finally {
    await context.close()
    await thirdContext.close()
  }
})

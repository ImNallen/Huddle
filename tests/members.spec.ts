import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { actAs, expectHome, inviteCode, join, loginOf, onboard, railTile } from './accounts'
import { useScratchServer } from './server'

const server = useScratchServer('ui')
const shortDate = (date: Date) =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

test('admins share an invite and see who joined; a friend moved to a new login keeps their history', async ({
  browser,
  page,
}) => {
  const colleague = await browser.newContext()
  const second = await colleague.newPage()
  try {
    await onboard(page, 'nallen', 'Harbor members')
    await page.getByRole('button', { name: 'Members', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'People on Harbor members' })).toBeVisible()
    const roster = page.getByRole('region', { name: /^Members/ })
    await expect(page.getByRole('region', { name: /^Pending invitations/ })).toHaveCount(0)
    await expect(roster.getByRole('row')).toHaveText([
      'NameRoleJoined',
      `nallen (you)Admin${shortDate(new Date())}`,
    ])
    await expect(page.getByText('You’re the only member so far.', { exact: false })).toBeVisible()
    await expect(page.getByText("Huddle can't remove a member yet", { exact: false })).toBeVisible()

    await page.getByRole('button', { name: 'Share invite', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Copy invite' })).toBeVisible()
    await expect(dialog).not.toContainText('#join=')
    const code = await inviteCode(page)
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()

    await join(second, 'aiko', code)
    await expect(second.getByText('Welcome, aiko', { exact: true })).toBeVisible()
    await expect(
      second.getByRole('heading', { name: 'You’re in Harbor members.', level: 1 }),
    ).toBeVisible()
    await expect(second.getByRole('button', { name: 'Members', exact: true })).toHaveCount(0)
    await expect(second.getByRole('button', { name: 'Share invite', exact: true })).toHaveCount(0)
    const setup = second.getByRole('region', { name: 'Set up Harbor members' })
    await expect(setup).toContainText('1 of 3 done')
    await expect(setup.getByRole('listitem')).toHaveText([
      'You joined this serverYou joined from an invite.Done',
      /^Create the first room.*Waiting on an admin$/,
      /^Add a channel.*Waiting on an admin$/,
    ])
    await expect(setup.getByRole('button')).toHaveCount(0)
    await expect(second.getByText('Only admins see it.', { exact: false })).toHaveCount(0)
    await second.getByRole('button', { name: 'Member list', exact: true }).click()
    await expect(second.getByRole('list', { name: 'Members' })).toHaveText(
      'Admins — 1nallenMembers — 1aiko',
    )
    await expect(second.locator('.account-name > span').first()).toHaveText('Connected')

    const denied = await second.evaluate(async () => (await fetch('/api/invite')).status)
    expect(denied).toBe(403)

    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.getByRole('button', { name: 'Members', exact: true }).click()
    await expect(roster.getByRole('row')).toHaveText([
      'NameRoleJoined',
      `nallen (you)Admin${shortDate(new Date())}`,
      `aikoMember${shortDate(new Date())}`,
    ])
    await expect(page.getByText('You’re the only member so far.', { exact: false })).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Members' })).toHaveCount(0)
    await expect(page.locator('main')).not.toContainText('@huddle.test')

    await railTile(page, 'Create room').click()
    await page.getByLabel('Room name').fill('Product')
    await page.getByRole('dialog').getByRole('button', { name: 'Create room' }).click()
    await expect(setup).toContainText('2 of 3 done')
    await expect(setup.getByRole('listitem').nth(1)).toHaveText('Create the first roomProductDone')
    await page.getByRole('button', { name: 'Create a channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('general')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(setup).toHaveCount(0)
    await expect(
      second.getByRole('heading', { name: /^Good (morning|afternoon|evening), aiko$/ }),
    ).toBeVisible()

    const history = `Written before my login changed ${randomUUID()}`
    await railTile(second, 'Product').click()
    await second.getByRole('textbox', { name: 'Message #general' }).fill(history)
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(second.getByText(history, { exact: true })).toBeVisible()
    const { user } = await second.evaluate(async () => {
      const response = await fetch('/api/account')
      return (await response.json()) as { user: { id: string } }
    })

    await actAs(second, 'aiko-renamed')
    await second.reload()
    await expect(second.getByRole('heading', { name: 'Join Harbor members' })).toBeVisible()
    await expect(second.getByText(loginOf('aiko-renamed'), { exact: true })).toBeVisible()
    await expect(second.getByRole('button', { name: 'Copy login', exact: true })).toBeVisible()
    await expect(second.locator('main')).not.toContainText(history)

    const linked = await server.link(user.id, loginOf('aiko-renamed'))
    expect(linked.code, linked.stderr).toBe(0)
    expect(linked.stdout).toContain(`Linked ${loginOf('aiko-renamed')} to aiko`)
    await second.getByRole('button', { name: 'Check again', exact: true }).click()
    await expectHome(second)
    await railTile(second, 'Product').click()
    await expect(second.getByText(history, { exact: true })).toBeVisible()
    await expect(second.locator('.account-name > strong')).toHaveText('aiko')
  } finally {
    await colleague.close()
  }
})

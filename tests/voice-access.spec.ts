import { expect, test } from '@playwright/test'
import { runningLivekit } from '../apps/server/scripts/harness'
import { useScratchServer, websocketURL } from './server'
import {
  channelRow,
  expectInCall,
  fakeMicrophoneLaunch,
  join,
  main,
  openMicrophones,
  openRoom,
  panel,
  voicePeople,
} from './voice'

const graceSeconds = 8
const server = useScratchServer('api', { VOICE_ACCESS_GRACE_SECONDS: String(graceSeconds) })
const { voiceRoom, person } = voicePeople(server)
test.beforeAll(() => runningLivekit())
test.use({ launchOptions: fakeMicrophoneLaunch })

test('a call without an attested socket is ended by the server, and rejoining buys no more time', async ({
  browser,
}) => {
  const roomName = await voiceRoom('checked')
  let socketsRefused = false
  // A client that keeps its call but never holds a socket, as a modified one could.
  const ada = await person(browser, 'ada', roomName, undefined, (context) =>
    context.routeWebSocket(new RegExp(`^${websocketURL}`), (socket) => {
      if (socketsRefused) void socket.close()
      else socket.connectToServer()
    }),
  )
  const removed = "Huddle ended this call because it couldn't confirm your access."
  try {
    await channelRow(ada.page, roomName, 'checked').click()
    await join(ada.page).click()
    await expectInCall(ada.page)
    await ada.page.waitForTimeout((graceSeconds + 3) * 1000)
    await expect(panel(ada.page).getByRole('status')).toHaveText('Voice connected')

    socketsRefused = true
    await main(ada.page).getByRole('button', { name: 'Leave call', exact: true }).click()
    await ada.page.reload()
    await openRoom(ada.page, roomName)
    await channelRow(ada.page, roomName, 'checked').click()
    await join(ada.page).click()
    await expectInCall(ada.page)
    await expect(main(ada.page).getByRole('alert')).toContainText(removed, {
      timeout: (graceSeconds + 10) * 1000,
    })
    await expect.poll(() => openMicrophones(ada.page)).toBe(0)

    await main(ada.page).getByRole('button', { name: 'Try again', exact: true }).click()
    await expectInCall(ada.page)
    const rejoined = Date.now()
    await expect(main(ada.page).getByRole('alert')).toContainText(removed, { timeout: 20000 })
    expect(Date.now() - rejoined).toBeLessThan((graceSeconds - 2) * 1000)

    socketsRefused = false
    await ada.page.reload()
    await openRoom(ada.page, roomName)
    await channelRow(ada.page, roomName, 'checked').click()
    await join(ada.page).click()
    await expectInCall(ada.page)
    await ada.page.waitForTimeout(3000)
    await expect(panel(ada.page).getByRole('status')).toHaveText('Voice connected')
  } finally {
    await ada.context.close()
  }
})

import { expect, test } from '@playwright/test'
import { CredentialStore } from '../apps/desktop/src/credentials'

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
test('a cancelled late keychain write cannot erase a new same-origin credential', async () => {
  let value: string | null = null
  let active = true
  const entered = deferred()
  const release = deferred()
  const operations = {
    load: async () => value,
    save: async (_origin: string, token: string) => {
      if (token === 'old-owned-test-credential') {
        entered.resolve()
        await release.promise
      }
      value = token
    },
    clear: async () => {
      value = null
    },
  }
  const old = new CredentialStore('https://same-origin.huddle.test', operations)
  const next = new CredentialStore('https://same-origin.huddle.test', operations)
  const late = old.remember('old-owned-test-credential', () => active)
  await entered.promise
  active = false
  const fresh = next.remember('new-owned-test-credential', () => true)
  release.resolve()
  expect(await late).toBe(false)
  expect(await fresh).toBe(true)
  await old.forget()
  expect(value === 'new-owned-test-credential').toBe(true)
})
test('an unowned default connection does not clear an existing native credential', async () => {
  let cleared = false
  const credentials = new CredentialStore('http://localhost:3000', {
    load: async () => 'existing-test-credential',
    save: async () => undefined,
    clear: async () => {
      cleared = true
    },
  })
  await credentials.forget()
  expect(cleared).toBe(false)
})
test('cancellation before a queued save prevents the write', async () => {
  const entered = deferred()
  const release = deferred()
  const writes: string[] = []
  const operations = {
    load: async () => null,
    save: async (_origin: string, token: string) => {
      writes.push(token)
      if (token === 'blocking-test-credential') {
        entered.resolve()
        await release.promise
      }
    },
    clear: async () => undefined,
  }
  const first = new CredentialStore('https://queued.huddle.test', operations)
  const second = new CredentialStore('https://queued.huddle.test', operations)
  const blocker = first.remember('blocking-test-credential', () => true)
  await entered.promise
  let active = true
  const cancelled = second.remember('cancelled-test-credential', () => active)
  active = false
  release.resolve()
  await blocker
  expect(await cancelled).toBe(false)
  expect(writes.length).toBe(1)
})

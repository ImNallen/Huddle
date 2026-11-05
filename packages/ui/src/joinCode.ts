import { JoinCode } from '@huddle/contracts'

const key = (origin: string) => `huddle.join-code:${origin}`
export function readJoinCode(origin: string) {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key(origin))
}
export function saveJoinCode(origin: string, code: string) {
  localStorage.setItem(key(origin), code)
}
export function clearJoinCode(origin: string) {
  localStorage.removeItem(key(origin))
}
/** Moves a `#join=` code from the address bar to storage before the app reads it. Call it before
 *  rendering Application. */
export function takeInviteFromAddress(origin: string) {
  const { hash, pathname, search } = window.location
  if (!hash.startsWith('#join=')) return
  const code = JoinCode.safeParse(hash.slice('#join='.length))
  if (code.success) saveJoinCode(origin, code.data)
  window.history.replaceState(null, '', pathname + search)
}

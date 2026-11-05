import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const identityModule = 'src/lib/identity.ts'
const servePlayer = 'runtime/dev-serve.ts'
const devRuntime = 'runtime/dev.ts'

function violation(path: string, source: string): string | null {
  if (
    /tailscale[-_](user|funnel|headers)|x-forwarded-host/i.test(source) &&
    path !== identityModule &&
    path !== servePlayer
  )
    return `only ${identityModule} may read Tailscale headers`
  if (/\breadAttestation\b/.test(source) && path !== identityModule)
    return `only ${identityModule} may call readAttestation`
  if (/dev-serve/.test(source) && path !== devRuntime && path !== servePlayer)
    return `only ${devRuntime} may mention dev-serve`
  if (path === identityModule && /NODE_ENV|process\.env/.test(source))
    return 'identity must not change with the environment'
  if (path.startsWith('src/') && /x-forwarded-for|remoteAddress/i.test(source))
    return 'rate limits and access must not depend on the peer address, which is always loopback'
  return null
}
async function check(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await check(path)
    else if (/\.tsx?$/.test(path)) {
      const name = relative(process.cwd(), path)
      const problem = violation(name, await readFile(path, 'utf8'))
      if (problem) throw new Error(`${name}: ${problem}`)
    }
  }
}
await check(join(process.cwd(), 'src'))
await check(join(process.cwd(), 'runtime'))

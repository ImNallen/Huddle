import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

async function check(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await check(path)
    else if (/\.tsx?$/.test(path)) {
      const source = await readFile(path, 'utf8')
      if (
        /\.api\.getSession\s*\(|\.internalAdapter\.createSession\s*\(/.test(source) &&
        relative(process.cwd(), path) !== 'src/lib/access.ts'
      )
        throw new Error(`${path} must use the access admission boundary`)
    }
  }
}
await check(join(process.cwd(), 'src'))
await check(join(process.cwd(), 'runtime'))

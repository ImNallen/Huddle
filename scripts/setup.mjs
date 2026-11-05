import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'server-url': { type: 'string' } } })
const password = randomBytes(24).toString('hex')
const database = `DATABASE_URL=postgresql://huddle:${password}@localhost:5434/huddle\nPOSTGRES_PASSWORD=${password}\n`
const contents = values['server-url']
  ? `${database}SERVER_URL=${values['server-url']}\n`
  : `${database}SERVER_URL=http://localhost:3000\nPORT=3002\nWS_PORT=3003\nWS_PUBLIC_URL=ws://localhost:3000/events\nHUDDLE_DEV_LOGIN=you@huddle.local\nTRUSTED_ORIGINS=http://localhost:1420,http://127.0.0.1:1420\n`
try {
  await writeFile(new URL('../.env', import.meta.url), contents, { flag: 'wx', mode: 0o600 })
  process.stdout.write(
    'Created .env with a generated database password. Run docker compose up -d db.\n',
  )
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  process.stdout.write('.env already exists. Kept your configuration.\n')
}

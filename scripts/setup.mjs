import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
const password = randomBytes(24).toString('hex')
const contents = `DATABASE_URL=postgresql://huddle:${password}@localhost:5432/huddle\nPOSTGRES_PASSWORD=${password}\nBETTER_AUTH_SECRET=${randomBytes(48).toString('base64url')}\nSERVER_URL=http://localhost:3000\nWS_PUBLIC_URL=ws://localhost:3001\nTRUSTED_ORIGINS=http://localhost:1420,http://127.0.0.1:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost\n\nNODE_ENV=development\nSMTP_HOST=127.0.0.1\nSMTP_PORT=1025\nSMTP_SECURITY=local\nSMTP_FROM=huddle@huddle.test\nSMTP_SERVER_NAME=Huddle\n`
try {
  await writeFile(new URL('../.env', import.meta.url), contents, { flag: 'wx', mode: 0o600 })
  process.stdout.write(
    'Created .env with generated secrets and local Mailpit email. Run docker compose --profile dev up -d db mailpit.\n',
  )
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  process.stdout.write('.env already exists. Kept your configuration.\n')
}

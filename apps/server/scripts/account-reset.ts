import { text } from 'node:stream/consumers'
import { Password, Username } from '@huddle/contracts'
import { db } from '../src/lib/db'
import { resetPasswordByUsername } from '../src/lib/friends'

async function readPassword() {
  if (!process.stdin.isTTY) return (await text(process.stdin)).replace(/\r?\n$/, '')
  process.stderr.write('New password: ')
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  let password = ''
  for await (const chunk of process.stdin) {
    for (const char of String(chunk)) {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stderr.write('\n')
        return password
      }
      if (char === '\u0003') process.exit(130)
      password = char === '\u007f' ? password.slice(0, -1) : password + char
    }
  }
  return password
}

try {
  const username = Username.safeParse(process.argv[2] ?? '')
  if (!username.success) {
    process.stderr.write('Usage: pnpm --filter @huddle/server account:reset <username>\n')
    process.exitCode = 2
  } else {
    const password = Password.safeParse(await readPassword())
    if (!password.success) {
      process.stderr.write('The password must be 8 to 200 characters.\n')
      process.exitCode = 1
    } else if (!(await resetPasswordByUsername(username.data, password.data))) {
      process.stderr.write(`No account has the username ${username.data}.\n`)
      process.exitCode = 1
    } else
      process.stdout.write(
        `Reset the password for ${username.data}. Every session for that account is signed out.\n`,
      )
  }
} finally {
  await db.end()
}

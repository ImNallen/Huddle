import { TailscaleLogin } from '@huddle/contracts'
import { listAccounts, moveLogin } from '../src/lib/accounts'
import { db } from '../src/lib/db'

const usage = 'Usage: pnpm --filter @huddle/server account:link [<id-or-old-username> <login>]\n'
const withoutControlCharacters = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, '�')

async function list() {
  const accounts = await listAccounts()
  if (!accounts.length) {
    process.stdout.write('No accounts yet. Set the server up first.\n')
    return
  }
  const rows = [
    ['ID', 'ROLE', 'NAME', 'OLD USERNAME', 'JOINED', 'LOGIN'],
    ...accounts.map((account) => [
      account.id,
      account.role,
      withoutControlCharacters(account.name),
      account.legacyUsername ?? '-',
      account.joinedAt.toISOString().slice(0, 10),
      account.login ?? '(none)',
    ]),
  ]
  const widths = (rows[0] ?? []).map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  )
  for (const row of rows)
    process.stdout.write(
      `${row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd()}\n`,
    )
}

async function link(target: string, value: string) {
  const login = TailscaleLogin.safeParse(value)
  if (!login.success) {
    process.stderr.write(`${value} is not a Tailscale login, such as you@example.com.\n`)
    process.exitCode = 1
    return
  }
  const result = await moveLogin(target, login.data)
  if (!result.moved) {
    process.stderr.write(`No single member has the ID or old username ${target}.\n`)
    process.exitCode = 1
    return
  }
  const moved = result.from
    ? ` It came from ${withoutControlCharacters(result.from.name)} (${result.from.id}), which now has no login and cannot be reached until you link it again.`
    : ' No other account held it.'
  const replaced =
    result.previous && result.previous !== login.data
      ? ` ${result.previous} no longer reaches this account.`
      : ''
  process.stdout.write(
    `Linked ${login.data} to ${withoutControlCharacters(result.name)} (${result.account}).${moved}${replaced}\n`,
  )
}

try {
  const [target, login, ...rest] = process.argv.slice(2)
  if (rest.length || (target && !login)) {
    process.stderr.write(usage)
    process.exitCode = 2
  } else if (target && login) await link(target, login)
  else await list()
} finally {
  await db.end()
}

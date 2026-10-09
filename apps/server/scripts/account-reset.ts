import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { db } from '../src/lib/db'
import { digest, opaque, transaction } from '../src/lib/access-store'

try {
  const [command, requestId, operator, reason, output] = process.argv.slice(2)
  if (command === 'list') {
    const result = await db.query(
      'SELECT id,requested_at,operator,expires_at,used_at FROM account_reset WHERE ($1::text IS NULL OR email=$1) ORDER BY requested_at DESC LIMIT 100',
      [requestId ? z.email().parse(requestId).toLowerCase() : null],
    )
    process.stdout.write(`${JSON.stringify(result.rows, null, 2)}\n`)
  } else if (command === 'issue') {
    const input = z
      .object({
        requestId: z.uuid(),
        operator: z.string().trim().min(1),
        reason: z.string().trim().min(20),
        output: z.string().min(1),
      })
      .parse({ requestId, operator, reason, output })
    if (process.env.HUDDLE_IDENTITY_CONFIRMED !== 'yes')
      throw new Error(
        'Set HUDDLE_IDENTITY_CONFIRMED=yes only after independently confirming this account owner. Workspace ownership is insufficient.',
      )
    const capability = opaque()
    await transaction(async (sql) => {
      const result = await sql.query(
        "UPDATE account_reset SET operator=$2,reason=$3,capability_hash=$4,expires_at=now()+interval '15 minutes' WHERE id=$1 AND used_at IS NULL AND capability_hash IS NULL RETURNING id",
        [input.requestId, input.operator, input.reason, digest(`reset:${capability}`)],
      )
      if (!result.rowCount) throw new Error('Request is unavailable or already issued.')
      await writeFile(input.output, `${capability}\n`, { flag: 'wx', mode: 0o600 })
    })
    process.stdout.write(
      'Wrote the single-use reset capability to the protected output file. It expires in 15 minutes.\n',
    )
  } else
    throw new Error(
      'Usage: account-reset.ts list | issue REQUEST_ID OPERATOR CONFIRMATION_REASON OUTPUT_FILE',
    )
} finally {
  await db.end()
}

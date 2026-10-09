import { readFile, readdir } from 'node:fs/promises'
import { getMigrations } from 'better-auth/db/migration'
import { auth } from '../src/lib/auth'
import { db } from '../src/lib/db'

try {
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  const connection = await db.connect()
  try {
    await connection.query('BEGIN')
    await connection.query('SELECT pg_advisory_xact_lock(7194152)')
    await connection.query(
      'CREATE TABLE IF NOT EXISTS huddle_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    for (const name of (await readdir(new URL('../migrations/', import.meta.url)))
      .filter((file) => file.endsWith('.sql'))
      .sort()) {
      const applied = await connection.query('SELECT name FROM huddle_migration WHERE name = $1', [
        name,
      ])
      if (applied.rowCount) continue
      await connection.query(
        await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'),
      )
      await connection.query('INSERT INTO huddle_migration(name) VALUES ($1)', [name])
    }
    await connection.query('COMMIT')
    process.stdout.write('Huddle migrations applied.\n')
  } catch (error) {
    await connection.query('ROLLBACK')
    throw error
  } finally {
    connection.release()
  }
} finally {
  await db.end()
}

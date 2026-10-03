import { Pool } from 'pg'
import { z } from 'zod'

import {
  loadMigrations,
  migrate,
  MigrationError,
  migrationStatus,
} from '../src/infrastructure/db/migrator.js'

const out = process.stdout.write.bind(process.stdout)
const fail = process.stderr.write.bind(process.stderr)

const command = z.enum(['status', 'up']).safeParse(process.argv[2])
const databaseUrl = z.url().safeParse(process.env['DATABASE_URL'])

if (!command.success || !databaseUrl.success) {
  fail('usage: DATABASE_URL=postgres://... tsx scripts/migrate.ts <up|status>\n')
  process.exit(2)
}

const pool = new Pool({ application_name: 'triple-migrator', connectionString: databaseUrl.data })

try {
  const migrations = await loadMigrations('migrations')

  if (command.data === 'up') {
    const applied = await migrate(pool, migrations)
    for (const migration of applied) {
      const mode = migration.transactional ? '' : ' (no transaction)'
      out(`applied ${migration.version}_${migration.name}${mode}\n`)
    }
    out(applied.length === 0 ? 'nothing to apply\n' : `${applied.length} applied\n`)
  } else {
    const status = await migrationStatus(pool, migrations)
    for (const row of status.applied) {
      out(`applied  ${row.version}_${row.name}  ${row.appliedAt.toISOString()}\n`)
    }
    for (const migration of status.pending) {
      out(`pending  ${migration.version}_${migration.name}\n`)
    }
  }
} catch (error) {
  const message = error instanceof MigrationError ? error.message : String(error)
  fail(`migration failed: ${message}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}

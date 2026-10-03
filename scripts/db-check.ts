import { closeDbPool, dbPool } from '../src/infrastructure/db/pool.js'

const out = process.stdout.write.bind(process.stdout)
const fail = process.stderr.write.bind(process.stderr)

interface SessionRow {
  database_name: string
  session_user: string
  timezone: string
}

interface VersionRow {
  version: string
}

async function connectOrExit(): Promise<void> {
  try {
    await dbPool().query('SELECT 1')
  } catch (error) {
    fail(`cannot reach postgres: ${(error as Error).message}\nrun: npm run db:up\n`)
    await closeDbPool()
    process.exit(1)
  }
}

await connectOrExit()

const versionResult = await dbPool().query<VersionRow>('SELECT version() AS version')
const sessionResult = await dbPool().query<SessionRow>(`
  SELECT current_database() AS database_name,
         session_user       AS session_user,
         current_setting('timezone') AS timezone
`)

const version = versionResult.rows[0]
const session = sessionResult.rows[0]

if (!version || !session) {
  fail('unexpected empty result while inspecting the database\n')
  await closeDbPool()
  process.exit(1)
}

out(`postgres:    ${version.version.split(',')[0]}\n`)
out(`database:    ${session.database_name} as ${session.session_user}\n`)
out(`timezone:    ${session.timezone}\n`)
out('migrations:  pending (runner arrives with phase 1)\n')

await closeDbPool()

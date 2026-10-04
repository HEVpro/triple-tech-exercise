import type { Pool, PoolClient } from 'pg'

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadMigrations, migrate, migrationStatus } from '../src/infrastructure/db/migrator.js'
import {
  createTempDatabase,
  databaseAvailable,
  type TempDatabase,
} from './support/temp-database.js'

const available = await databaseAvailable()

let temp: TempDatabase
let pool: Pool
let tenantId: string

beforeAll(async () => {
  if (!available) return
  temp = await createTempDatabase()
  pool = temp.pool
  await migrate(pool, await loadMigrations('migrations'))

  tenantId = randomUUID()
  await pool.query(`INSERT INTO tenants (id, name, base_currency) VALUES ($1, 'Acme', 'EUR')`, [
    tenantId,
  ])
})

afterAll(async () => {
  if (available) await temp.drop()
})

async function asAppRole<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE triple_app')
    return await work(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function insertCase(client: Pool | PoolClient = pool): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO cases (
       tenant_id, external_ref, amount_minor, currency, amount_base_minor, base_currency,
       fx_rate, fx_rate_date, scheme, reason_code, presentment_date, deadline_at,
       deadline_window_id, deadline_window_days, deadline_tz, status, decided_by_rule, version
     )
     SELECT $1, $2, 10000, 'EUR', 10000, 'EUR', 1, '2026-01-01', 'VISA', '10.4',
            '2026-09-01', '2026-10-17T00:00:00Z', w.id, w.window_days, w.deadline_tz,
            'OPEN', 'default_open', 1
     FROM response_windows w WHERE w.scheme = 'VISA' AND w.reason_code IS NULL
     RETURNING id`,
    [tenantId, `ref-${randomUUID()}`],
  )
  const id = result.rows[0]?.id
  if (!id) throw new Error('case insert returned no id')
  return id
}

async function insertCreatedEvent(caseId: string, extra = ''): Promise<void> {
  await pool.query(
    `INSERT INTO case_events (
       case_id, seq, tenant_id, event_type, actor_type, actor_id, from_status, to_status,
       rule_key, ruleset_version ${extra ? ', occurred_at' : ''}
     ) VALUES ($1, 1, $2, 'CASE_CREATED', 'human', 'analyst-1', NULL, 'OPEN',
       'default_open', 1 ${extra ? `, ${extra}` : ''})`,
    [caseId, tenantId],
  )
}

describe.skipIf(!available)('migration runner against a real database', () => {
  it('records every migration and applies nothing on a second run', async () => {
    const migrations = await loadMigrations('migrations')

    await expect(migrate(pool, migrations)).resolves.toEqual([])
    const status = await migrationStatus(pool, migrations)
    expect(status.pending).toEqual([])
    expect(status.applied.map((row) => row.version)).toEqual(migrations.map((m) => m.version))
  })

  it('refuses to run when an applied migration was edited', async () => {
    const migrations = await loadMigrations('migrations')
    const tampered = migrations.map((m, index) => (index === 0 ? { ...m, checksum: 'edited' } : m))

    await expect(migrate(pool, tampered)).rejects.toThrow(/edited after being applied/)
  })

  it('refuses to run when an applied migration is missing from disk', async () => {
    const migrations = await loadMigrations('migrations')

    await expect(migrate(pool, migrations.slice(1))).rejects.toThrow(/missing from disk/)
  })

  it('leaves every concurrently built index valid', async () => {
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'cases' AND indexname LIKE 'cases\\_%\\_idx' ORDER BY indexname`,
    )
    expect(result.rows.map((row) => row.indexname)).toEqual([
      'cases_queue_breached_idx',
      'cases_queue_idx',
      'cases_sweep_idx',
    ])
    const invalid = await pool.query('SELECT 1 FROM pg_index WHERE NOT indisvalid')
    expect(invalid.rowCount).toBe(0)
  })
})

describe.skipIf(!available)('case_events is append-only', () => {
  it('rejects UPDATE, DELETE and TRUNCATE even for the table owner', async () => {
    const caseId = await insertCase()
    await insertCreatedEvent(caseId)

    await expect(
      pool.query(`UPDATE case_events SET reason = 'x' WHERE case_id = $1`, [caseId]),
    ).rejects.toThrow(/append-only: UPDATE/)
    await expect(
      pool.query('DELETE FROM case_events WHERE case_id = $1', [caseId]),
    ).rejects.toThrow(/append-only: DELETE/)
    await expect(pool.query('TRUNCATE case_events')).rejects.toThrow(/append-only: TRUNCATE/)
  })

  it('refuses to delete a case that has events', async () => {
    const caseId = await insertCase()
    await insertCreatedEvent(caseId)

    await expect(pool.query('DELETE FROM cases WHERE id = $1', [caseId])).rejects.toThrow(
      /foreign key/,
    )
  })

  it('rejects a second event with the same sequence number', async () => {
    const caseId = await insertCase()
    await insertCreatedEvent(caseId)

    await expect(insertCreatedEvent(caseId)).rejects.toThrow(/case_events_pkey/)
  })
})

describe.skipIf(!available)('event clocks', () => {
  it('stamps recorded_at with the database clock', async () => {
    const caseId = await insertCase()
    await insertCreatedEvent(caseId)

    const result = await pool.query<{ drift_ms: number; same: boolean }>(
      `SELECT occurred_at = recorded_at AS same,
              abs(extract(EPOCH FROM (now() - recorded_at)) * 1000)::int AS drift_ms
       FROM case_events WHERE case_id = $1`,
      [caseId],
    )
    expect(result.rows[0]?.same).toBe(true)
    expect(result.rows[0]?.drift_ms).toBeLessThan(5_000)
  })

  it('rejects a backdated occurred_at on a client event', async () => {
    const caseId = await insertCase()

    await expect(insertCreatedEvent(caseId, `'2020-01-01T00:00:00Z'`)).rejects.toThrow(
      /case_events_occurred_at_check/,
    )
  })

  it('lets the deadline expiry carry the deadline as its business time', async () => {
    const caseId = await insertCase()
    await insertCreatedEvent(caseId)

    await pool.query(
      `INSERT INTO case_events (
         case_id, seq, tenant_id, event_type, actor_type, actor_id, from_status, to_status,
         rule_key, ruleset_version, occurred_at
       ) VALUES ($1, 2, $2, 'DEADLINE_EXPIRED', 'system', 'deadline-sweeper', 'OPEN', 'LOST',
         'deadline_passed', 1, '2026-01-01T00:00:00Z')`,
      [caseId, tenantId],
    )

    const result = await pool.query<{ occurred_at: Date }>(
      'SELECT occurred_at FROM case_events WHERE case_id = $1 AND seq = 2',
      [caseId],
    )
    expect(result.rows[0]?.occurred_at.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('only lets the system expire a deadline', async () => {
    const caseId = await insertCase()
    await insertCreatedEvent(caseId)

    await expect(
      pool.query(
        `INSERT INTO case_events (
           case_id, seq, tenant_id, event_type, actor_type, actor_id, from_status, to_status,
           rule_key, ruleset_version
         ) VALUES ($1, 2, $2, 'DEADLINE_EXPIRED', 'human', 'analyst-1', 'OPEN', 'LOST',
           'deadline_passed', 1)`,
        [caseId, tenantId],
      ),
    ).rejects.toThrow(/case_events_system_actor_check/)
  })
})

describe.skipIf(!available)('application role privileges', () => {
  it('can insert cases and events and move the projection forward', async () => {
    await asAppRole(async (client) => {
      const caseId = await insertCase(client)
      await expect(
        client.query(`UPDATE cases SET status = 'UNDER_REVIEW', version = 2 WHERE id = $1`, [
          caseId,
        ]),
      ).resolves.toBeDefined()
    })
  })

  it('cannot change the immutable columns of a case', async () => {
    await asAppRole(async (client) => {
      const caseId = await insertCase(client)
      await expect(
        client.query('UPDATE cases SET amount_minor = 1 WHERE id = $1', [caseId]),
      ).rejects.toThrow(/permission denied/)
    })
  })

  it('cannot delete cases', async () => {
    await asAppRole(async (client) => {
      await expect(client.query('DELETE FROM cases')).rejects.toThrow(/permission denied/)
    })
  })

  it('cannot update events', async () => {
    await asAppRole(async (client) => {
      await expect(client.query(`UPDATE case_events SET reason = 'x'`)).rejects.toThrow(
        /permission denied/,
      )
    })
  })
})

describe.skipIf(!available)('response windows', () => {
  it('ships the brief defaults', async () => {
    const result = await pool.query<{ scheme: string; window_days: number }>(
      `SELECT scheme, window_days FROM response_windows
       WHERE reason_code IS NULL ORDER BY scheme`,
    )
    expect(result.rows).toEqual([
      { scheme: 'MASTERCARD', window_days: 45 },
      { scheme: 'OTHER', window_days: 30 },
      { scheme: 'VISA', window_days: 45 },
    ])
  })

  it('allows one default per scheme, so resolution is never ambiguous', async () => {
    await expect(
      pool.query(`INSERT INTO response_windows (scheme, window_days) VALUES ('VISA', 60)`),
    ).rejects.toThrow(/response_windows_scheme_reason_code_key/)
  })
})

describe('schema suite without a database', () => {
  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})

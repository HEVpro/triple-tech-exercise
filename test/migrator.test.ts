import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadMigrations, MigrationError } from '../src/infrastructure/db/migrator.js'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true })
  directory = undefined
})

async function folderWith(files: Record<string, string>): Promise<string> {
  directory = await mkdtemp(path.join(tmpdir(), 'triple-migrations-'))
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(directory, name), sql)
  }
  return directory
}

describe('loading migrations from disk', () => {
  it('orders files by version and detects the no-transaction marker', async () => {
    const folder = await folderWith({
      '0001_first.sql': 'CREATE TABLE a (id INT);',
      '0002_index.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY a_idx ON a (id);',
    })

    const migrations = await loadMigrations(folder)

    expect(migrations.map((m) => [m.version, m.name, m.transactional])).toEqual([
      ['0001', 'first', true],
      ['0002', 'index', false],
    ])
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a no-transaction migration with more than one statement', async () => {
    const folder = await folderWith({
      '0001_two.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY a ON t (x);\nSELECT 1;',
    })

    await expect(loadMigrations(folder)).rejects.toThrow(/exactly one statement/)
  })

  it('rejects a file that does not follow the naming convention', async () => {
    const folder = await folderWith({ 'create_things.sql': 'SELECT 1;' })

    await expect(loadMigrations(folder)).rejects.toBeInstanceOf(MigrationError)
  })

  it('rejects two files with the same version', async () => {
    const folder = await folderWith({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' })

    await expect(loadMigrations(folder)).rejects.toThrow(/duplicate version 0001/)
  })

  it('loads the real migrations directory', async () => {
    const migrations = await loadMigrations('migrations')

    expect(migrations.length).toBeGreaterThan(0)
    expect(migrations.filter((m) => !m.transactional).map((m) => m.name)).toEqual([
      'cases_at_risk_index',
      'cases_breached_index',
      'cases_sweep_index',
      'cases_queue_index',
      'cases_queue_breached_index',
      'drop_cases_at_risk_index',
      'drop_cases_breached_index',
    ])
  })
})

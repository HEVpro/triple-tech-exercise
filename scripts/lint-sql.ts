import type { Parser as SqlParser } from 'node-sql-parser'

import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { format } from 'sql-formatter'

const SQL_DIRECTORIES = ['migrations', 'scripts/sql']
const require = createRequire(import.meta.url)
const parser = new (require('node-sql-parser') as { Parser: new () => SqlParser }).Parser()

async function collectSqlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const collected: string[] = []

  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      collected.push(...(await collectSqlFiles(full)))
    } else if (entry.name.endsWith('.sql')) {
      collected.push(full)
    }
  }

  return collected
}

const files = (await Promise.all(SQL_DIRECTORIES.map(collectSqlFiles))).flat().sort()

if (files.length === 0) {
  process.stdout.write('no SQL files yet, nothing to check\n')
  process.exit(0)
}

const failures: string[] = []

for (const file of files) {
  const source = await readFile(file, 'utf8')

  try {
    parser.astify(source, { database: 'Postgresql' })
  } catch (error) {
    failures.push(`${file}: invalid PostgreSQL syntax -> ${(error as Error).message}`)
    continue
  }

  const canonical = format(source, { keywordCase: 'upper', language: 'sql', tabWidth: 2 })
  if (canonical.trim() !== source.trim()) {
    failures.push(`${file}: not canonically formatted, run: npx prettier --write ${file}`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exit(1)
}

process.stdout.write(`sql ok: ${files.length} file(s) parsed and formatted\n`)

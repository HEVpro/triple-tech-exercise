import { defineConfig } from 'drizzle-kit'

// drizzle-kit generates and checks migrations; it does not apply them. Applying is done by
// src/infrastructure/db/migrator.ts, because drizzle's migrator runs every pending migration in
// one transaction (no CREATE INDEX CONCURRENTLY), only compares the last applied timestamp (no
// checksums, out-of-order files skipped silently) and takes no lock (D-38).
export default defineConfig({
  breakpoints: true,
  dialect: 'postgresql',
  migrations: {
    // 20261003120000_name.sql sorts after the hand-written 0001–0010 and never collides with them.
    prefix: 'timestamp',
  },
  out: './migrations',
  schema: './src/infrastructure/db/schema/index.ts',
  strict: true,
  verbose: true,
})

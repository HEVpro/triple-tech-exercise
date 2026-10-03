import * as drizzleKitApi from 'drizzle-kit/api'

// drizzle-kit/api declares its snapshot type with zod 3's TypeOf. With zod 4 installed that type
// does not resolve (tsc hides it behind skipLibCheck; typed ESLint does not). Only the generated
// SQL matters here, so the two functions are re-typed to exactly what is used.
interface DrizzleKitApi {
  generateDrizzleJson: (imports: Record<string, unknown>, prevId?: string) => { id: string }
  generateMigration: (prev: { id: string }, cur: { id: string }) => Promise<string[]>
}

const api = drizzleKitApi as unknown as DrizzleKitApi

// The SQL drizzle-kit would generate to build `schema` from an empty database.
export function sqlForSchema(schema: Record<string, unknown>): Promise<string[]> {
  const empty = api.generateDrizzleJson({})
  return api.generateMigration(empty, api.generateDrizzleJson(schema, empty.id))
}

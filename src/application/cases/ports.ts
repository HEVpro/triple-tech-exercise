import type { RecordedEvent } from '../../domain/events/index.js'
import type { EventDraft } from '../../domain/events/index.js'
import type { RuleConfigEntry, RuleKey } from '../../domain/rules/index.js'
import type { CaseStatus } from '../../domain/shared/index.js'
import type {
  CaseRecord,
  FxRateRecord,
  NewCaseRecord,
  QueuePageQuery,
  QueueSummary,
  QueueWindow,
  ResponseWindowRecord,
  Scheme,
  TenantRecord,
} from './types.js'

// What the use cases need from storage. The application depends on this interface, never on
// the Postgres adapter that implements it (src/infrastructure/db/case-store.ts).

export interface CaseStore {
  // Runs `work` in one database transaction. Everything a use case writes (the projection and
  // its events) commits together or not at all. `snapshot` makes it read-only and REPEATABLE
  // READ, so a read made of several queries (a report's summary and page, a case and its events)
  // sees one consistent state of the database.
  transaction<T>(
    work: (tx: CaseTransaction) => Promise<T>,
    options?: { snapshot?: boolean },
  ): Promise<T>
}

export interface CaseTransaction {
  // Moves the projection forward by one event: version + 1, and the new status and rule.
  advance(record: CaseRecord, status: CaseStatus, decidedByRule: RuleKey): Promise<CaseRecord>
  // Appends events with explicit sequence numbers; the database stamps recorded_at.
  appendEvents(
    record: CaseRecord,
    events: readonly { draft: EventDraft; seq: number }[],
  ): Promise<void>
  caseByExternalRef(tenantId: string, externalRef: string): Promise<CaseRecord | null>
  // `forUpdate` locks the row until the transaction ends, serialising writes to one case.
  caseById(
    tenantId: string,
    id: string,
    options?: { forUpdate?: boolean },
  ): Promise<CaseRecord | null>
  // OPEN cases whose deadline is at or before `now`, oldest deadline first, across all tenants,
  // locked FOR UPDATE SKIP LOCKED: concurrent sweepers never take the same case.
  dueForExpiry(now: Date, limit: number): Promise<CaseRecord[]>
  events(caseId: string): Promise<RecordedEvent[]>
  fxRate(currency: string, baseCurrency: string): Promise<FxRateRecord | null>
  // Returns null when (tenant_id, external_ref) already exists; never throws on that conflict.
  insertCase(values: NewCaseRecord): Promise<CaseRecord | null>
  // The transaction's clock: PostgreSQL now(), the same instant recorded_at will carry.
  now(): Promise<Date>
  queuePage(query: QueuePageQuery): Promise<CaseRecord[]>
  queueSummary(window: QueueWindow): Promise<QueueSummary>
  responseWindow(scheme: Scheme, reasonCode: string): Promise<null | ResponseWindowRecord>
  ruleConfig(tenantId: string): Promise<RuleConfigEntry[]>
  tenant(id: string): Promise<null | TenantRecord>
}

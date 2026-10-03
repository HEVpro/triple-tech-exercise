import type { RecordedEvent } from '../events/index.js'
import type { CaseStatus } from '../shared/index.js'
import type { HistoryView } from './types.js'

import { HISTORY_EVENT_CAP } from './constants.js'

// Reconstructs a case as the record stood at `asOf`. It folds the stored statuses in seq
// order and never evaluates a rule, so neither a code change nor a tenant's rule
// configuration can change what this returns for a past instant (D-11).
export function foldHistory(
  events: readonly RecordedEvent[],
  asOf: Date,
  cap: number = HISTORY_EVENT_CAP,
): HistoryView {
  const visible = events
    .filter((event) => event.recordedAt.getTime() <= asOf.getTime())
    .sort((a, b) => a.seq - b.seq)
  const truncated = visible.length > cap
  const kept = truncated ? visible.slice(0, cap) : visible

  const last = kept.at(-1)
  if (!last) return { decidedBy: null, events: [], state: null, truncated: false }

  // Every event but a note names the rule that decided it, and the first event of a case is
  // never a note, so for a real log a deciding event always exists.
  const deciding = kept.findLast(
    (event): event is Exclude<RecordedEvent, { type: 'NOTE_ADDED' }> => event.type !== 'NOTE_ADDED',
  )
  return {
    decidedBy: deciding
      ? { ruleKey: deciding.ruleKey, rulesetVersion: deciding.rulesetVersion, seq: deciding.seq }
      : null,
    events: kept,
    state: { status: last.to, version: last.seq },
    truncated,
  }
}

// Invariant 3: the projection agrees with the log. Used by tests and by the per-tenant
// verification in the migration plan.
export function projectionMatchesLog(
  projection: { status: CaseStatus; version: number },
  events: readonly RecordedEvent[],
): boolean {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const gapless = sorted.every((event, index) => event.seq === index + 1)
  const last = sorted.at(-1)
  return gapless && last?.to === projection.status && last.seq === projection.version
}

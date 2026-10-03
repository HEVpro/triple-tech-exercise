import type { ConfigurableRuleKey } from '../../domain/rules/index.js'
import type { CaseStore } from './ports.js'

import { decideSweep } from '../../domain/dispute/index.js'
import { resolveRuleOrder } from '../../domain/rules/index.js'

export interface SweepOptions {
  // Cases per transaction. Small enough to keep locks short, large enough to keep up.
  batchSize: number
  // A bound on one run, so a backlog is worked through over several runs instead of one long one.
  maxBatches: number
  // Stored on every DEADLINE_EXPIRED event, to trace which run recorded it.
  sweepRunId: string
}

export interface SweepResult {
  batches: number
  expired: number
  // How late the most overdue case was recorded: now() minus its deadline. The sweep's lag.
  maxLagSeconds: number
}

// One sweep: records DEADLINE_EXPIRED for every OPEN case whose deadline has passed, in batches,
// one transaction each. The single entry point for every way of running it: the worker loop,
// `npm run sweep`, or a scheduler such as EventBridge + Lambda or a Kubernetes CronJob.
//
// Safe to run concurrently (SKIP LOCKED) and idempotent: a swept case is no longer OPEN, so a
// second run finds nothing (D-9).
export async function sweepDeadlines(
  store: CaseStore,
  options: SweepOptions,
): Promise<SweepResult> {
  const result: SweepResult = { batches: 0, expired: 0, maxLagSeconds: 0 }

  while (result.batches < options.maxBatches) {
    const selected = await store.transaction(async (tx) => {
      const now = await tx.now()
      const due = await tx.dueForExpiry(now, options.batchSize)
      const orders = new Map<string, readonly ConfigurableRuleKey[]>()

      for (const record of due) {
        let ruleOrder = orders.get(record.tenant_id)
        if (!ruleOrder) {
          ruleOrder = resolveRuleOrder(await tx.ruleConfig(record.tenant_id))
          orders.set(record.tenant_id, ruleOrder)
        }

        const draft = decideSweep({
          now,
          ruleOrder,
          state: {
            deadlineAt: record.deadline_at,
            deadlineWindowDays: record.deadline_window_days,
            status: record.status,
          },
          sweepRunId: options.sweepRunId,
        })
        if (!draft) continue

        const advanced = await tx.advance(record, draft.to, 'deadline_passed')
        await tx.appendEvents(advanced, [{ draft, seq: advanced.version }])
        result.expired += 1
        result.maxLagSeconds = Math.max(
          result.maxLagSeconds,
          (now.getTime() - record.deadline_at.getTime()) / 1000,
        )
      }
      return due.length
    })

    result.batches += 1
    if (selected < options.batchSize) break
  }

  return result
}

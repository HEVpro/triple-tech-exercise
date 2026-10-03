import type { ConfigurableRuleKey, Predicate } from './types.js'

import { isWithinDeadline } from '../deadline/index.js'

// The terminal rules, one predicate each (docs/DOMAIN.md, "Terminal rules"). A predicate
// returns the status it decides, or null when it does not apply.
export const PREDICATES: Readonly<Record<ConfigurableRuleKey, Predicate>> = {
  // 1. The deadline passed and the bank never answered in time. The second condition is what
  //    the brief's wording leaves out: without it, a case that filed evidence on time would be
  //    lost the day the deadline passes, before the scheme has even decided (NOTES 2.10).
  deadline_passed: (facts, now) =>
    !isWithinDeadline(now, facts.deadlineAt) && !facts.evidenceFiledInTime ? 'LOST' : null,

  // 2. Evidence was filed in time and the scheme has not decided yet.
  evidence_filed: (facts) =>
    facts.evidenceFiledInTime && facts.outcome === null ? 'UNDER_REVIEW' : null,

  // 3. The scheme decided.
  scheme_outcome: (facts) => facts.outcome,
}

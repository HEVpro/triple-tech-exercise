import type { EventDraft } from '../events/index.js'
import type { Actor } from '../shared/index.js'
import type { CaseState } from './types.js'

import { validateEventDraft } from '../events/index.js'
import { DisputeError } from './errors.js'

// A note records work on a case without changing its status or claiming a rule.
export function decideNote(input: { actor: Actor; state: CaseState; text: string }): EventDraft {
  if (input.actor.type === 'system') {
    throw new DisputeError('notes are written by a human or an agent')
  }
  return validateEventDraft({
    actor: input.actor,
    from: input.state.status,
    metadata: { text: input.text },
    occurredAt: null,
    reason: null,
    ruleKey: null,
    rulesetVersion: null,
    to: input.state.status,
    type: 'NOTE_ADDED',
  })
}

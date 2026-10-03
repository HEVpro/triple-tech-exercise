// Dispute: the dispute-case aggregate. Decides what happens to a case (creation, transitions,
// deadline sweep, notes) and reconstructs it from its log. It composes every other block and
// nothing imports from it. Type names keep the `Case` prefix, matching the `cases` table and
// the API.

export { HISTORY_EVENT_CAP } from './constants.js'
export { decideCreation } from './create.js'
export { DisputeError } from './errors.js'
export { foldHistory, projectionMatchesLog } from './history.js'
export { decideNote } from './note.js'
export { decideSweep } from './sweep.js'
export { decideTransition } from './transition.js'
export type { CaseState, HistoryView, TransitionDecision, TransitionRequest } from './types.js'

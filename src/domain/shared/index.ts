// Shared kernel: the vocabulary every other block uses (case statuses, actors). It depends on
// nothing, so any block may import it.

export { ACTOR_TYPES, type Actor, type ActorType, SYSTEM_SWEEPER } from './actor.js'
export { CASE_STATUSES, type CaseStatus, isTerminal, type TerminalStatus } from './status.js'

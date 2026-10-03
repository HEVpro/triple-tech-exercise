export const ACTOR_TYPES = ['human', 'agent', 'system'] as const

// Who performed an action. Taken from the verified token, never from a request body.
export interface Actor {
  id: string
  type: ActorType
}

export type ActorType = (typeof ACTOR_TYPES)[number]

// The only system actor: it records automatic losses when a deadline passes.
export const SYSTEM_SWEEPER: Actor = { id: 'deadline-sweeper', type: 'system' }

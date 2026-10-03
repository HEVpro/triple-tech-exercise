import type { RequestIdVariables } from 'hono/request-id'

import type { Principal } from '../application/cases/index.js'

// Per-request values. `principal` is set only by the authenticate middleware, from the verified
// token; nothing else may set it.
export interface AppEnv {
  Variables: RequestIdVariables & { principal: Principal }
}

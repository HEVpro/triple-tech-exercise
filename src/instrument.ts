import { runtimeEnv } from './config/env.js'
import { startHttpMonitoring } from './monitoring/http.js'

// Loaded before the API with `--import` (see package.json), so monitoring starts before the
// application's modules are loaded.
startHttpMonitoring(runtimeEnv())

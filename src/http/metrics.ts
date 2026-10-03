import { collectDefaultMetrics, Histogram, Registry } from '@prometheus-io/client'

const registry = new Registry()
collectDefaultMetrics({ register: registry })

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export const httpRequestDuration = new Histogram({
  buckets,
  help: 'HTTP request duration in seconds, labelled by route template.',
  labelNames: ['method', 'route', 'status_code'],
  name: 'http_request_duration_seconds',
  registers: [registry],
})

export const metricsRegistry = registry

export function metricsContentType(): string {
  return registry.contentType
}

export async function renderMetrics(): Promise<string> {
  const body = await registry.metrics()
  return body
}

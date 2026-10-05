// The two development tenants, shared by dev-seed.ts and dev-token.ts. Fixed ids so tokens and
// cURL examples are reproducible. Two tenants, in two base currencies, so that tenant isolation
// and base-currency ordering can both be seen from the command line.
export const DEV_TENANTS = {
  acme: {
    base_currency: 'EUR',
    display_timezone: 'Europe/Madrid',
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Acme Issuer',
  },
  globex: {
    base_currency: 'USD',
    display_timezone: 'America/New_York',
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Globex Bank',
  },
} as const

// The order of the terminal rules is configurable per tenant (tenant_rule_config). Acme has no
// rows and uses the default order. Globex evaluates the scheme's outcome before the deadline, so
// the two can be compared: with no evidence and the deadline passed, an outcome that arrives
// before the sweeper has recorded the loss is refused by Acme and recorded by Globex
// (test/http/rule-order.integration.test.ts).
export const DEV_RULE_ORDER = [
  { priority: 1, rule_key: 'scheme_outcome', tenant_id: DEV_TENANTS.globex.id },
] as const

export type DevTenantSlug = keyof typeof DEV_TENANTS

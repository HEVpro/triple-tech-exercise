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

export type DevTenantSlug = keyof typeof DEV_TENANTS

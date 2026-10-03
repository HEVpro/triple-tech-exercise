// Money is an integer number of minor units plus an ISO 4217 currency. The number of minor
// units per major unit is 10^exponent, and the exponent is not always 2: JPY has 0, KWD has 3.
// That is why the brief's `amount_cents` is stored as `amount_minor`. No floating point ever
// touches an amount: conversions are done in bigint.

export class MoneyError extends Error {
  override name = 'MoneyError'
}

// ISO 4217 minor-unit exponents for the currencies this platform accepts. An explicit list,
// rather than a default of 2, so an unknown currency is rejected instead of silently scaled.
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  AED: 2,
  ARS: 2,
  AUD: 2,
  BHD: 3,
  BIF: 0,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CLP: 0,
  CNY: 2,
  CZK: 2,
  DJF: 0,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  GNF: 0,
  HKD: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NZD: 2,
  OMR: 3,
  PHP: 2,
  PLN: 2,
  PYG: 0,
  RON: 2,
  RWF: 0,
  SAR: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TND: 3,
  TRY: 2,
  TWD: 2,
  UGX: 0,
  USD: 2,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  ZAR: 2,
}

// Matches fx_rates.rate NUMERIC(20, 10).
const RATE_SCALE_DIGITS = 10
const RATE_PATTERN = /^(\d{1,10})(?:\.(\d{1,10}))?$/

export function currencyExponent(currency: string): number {
  const exponent = CURRENCY_EXPONENTS[currency]
  if (exponent === undefined) {
    throw new MoneyError(`unsupported currency: ${currency}`)
  }
  return exponent
}

export function isSupportedCurrency(currency: string): boolean {
  return currency in CURRENCY_EXPONENTS
}

// Converts an amount to the tenant's base currency at a fixed rate, where `rate` is the
// price of one major unit of `currency` in major units of `baseCurrency`, as a decimal
// string (the way PostgreSQL returns NUMERIC). Rounds half up to the base currency's minor
// unit.
export function toBaseMinor(
  amountMinor: bigint,
  currency: string,
  baseCurrency: string,
  rate: string,
): bigint {
  if (amountMinor < 0n) {
    throw new MoneyError('amount must not be negative')
  }

  const scaledRate = parseRate(rate)
  const numerator = amountMinor * scaledRate * 10n ** BigInt(currencyExponent(baseCurrency))
  const denominator = 10n ** BigInt(currencyExponent(currency)) * 10n ** BigInt(RATE_SCALE_DIGITS)

  return roundHalfUp(numerator, denominator)
}

function parseRate(rate: string): bigint {
  const match = RATE_PATTERN.exec(rate)
  if (!match?.[1]) {
    throw new MoneyError(`invalid rate: ${rate}`)
  }
  const fraction = (match[2] ?? '').padEnd(RATE_SCALE_DIGITS, '0')
  const scaled = BigInt(match[1] + fraction)
  if (scaled === 0n) {
    throw new MoneyError('rate must be positive')
  }
  return scaled
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator)
}

import { describe, expect, it } from 'vitest'

import {
  currencyExponent,
  isSupportedCurrency,
  MoneyError,
  toBaseMinor,
} from '../../../src/domain/money/index.js'

describe('currency exponents', () => {
  it('knows that not every currency has cents', () => {
    expect(currencyExponent('EUR')).toBe(2)
    expect(currencyExponent('JPY')).toBe(0)
    expect(currencyExponent('KWD')).toBe(3)
  })

  it('rejects a currency it does not know instead of assuming two decimals', () => {
    expect(() => currencyExponent('XXX')).toThrow(MoneyError)
    expect(isSupportedCurrency('XXX')).toBe(false)
    expect(isSupportedCurrency('USD')).toBe(true)
  })
})

describe('conversion to the base currency', () => {
  it('keeps the amount when the currency is the base', () => {
    expect(toBaseMinor(10_000n, 'EUR', 'EUR', '1')).toBe(10_000n)
  })

  it('accepts rates as PostgreSQL returns NUMERIC(20, 10)', () => {
    expect(toBaseMinor(10_000n, 'USD', 'EUR', '0.9200000000')).toBe(9_200n)
  })

  it('scales across currencies with different exponents', () => {
    // ¥100 000 at 0.0062 = €620.00
    expect(toBaseMinor(100_000n, 'JPY', 'EUR', '0.0062')).toBe(62_000n)
    // 1.000 KWD at 3.0 = €3.00
    expect(toBaseMinor(1_000n, 'KWD', 'EUR', '3.0')).toBe(300n)
  })

  it('orders money, not minor units', () => {
    // ¥30 000 is 30 000 minor units; €200.00 is 20 000. Sorting raw minor units would put the
    // yen case first, but it is worth €186, less than the euro case.
    const yen = toBaseMinor(30_000n, 'JPY', 'EUR', '0.0062')
    const euro = toBaseMinor(20_000n, 'EUR', 'EUR', '1')
    expect(yen).toBe(18_600n)
    expect(euro).toBeGreaterThan(yen)
  })

  it('rounds half up to the base minor unit', () => {
    expect(toBaseMinor(1n, 'USD', 'EUR', '0.5')).toBe(1n)
    expect(toBaseMinor(1n, 'USD', 'EUR', '0.4999999999')).toBe(0n)
  })

  it('stays exact for amounts far beyond the safe integer range', () => {
    expect(toBaseMinor(9_000_000_000_000_000_000n, 'EUR', 'EUR', '1')).toBe(
      9_000_000_000_000_000_000n,
    )
  })

  it('rejects negative amounts and malformed or zero rates', () => {
    expect(() => toBaseMinor(-1n, 'EUR', 'EUR', '1')).toThrow(/negative/)
    expect(() => toBaseMinor(1n, 'EUR', 'EUR', 'abc')).toThrow(/invalid rate/)
    expect(() => toBaseMinor(1n, 'EUR', 'EUR', '1e5')).toThrow(/invalid rate/)
    expect(() => toBaseMinor(1n, 'EUR', 'EUR', '0.0000')).toThrow(/positive/)
  })
})

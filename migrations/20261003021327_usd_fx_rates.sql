-- Fixed rates for tenants whose base currency is USD, so a USD-based bank can open cases in
-- other currencies and its stuck-queue report orders by money in its own currency.
-- Same simplification as 0004: static rates for the exercise, snapshotted onto each case.
-- Reference data only; no schema change, so drizzle-kit's snapshot is unchanged.
-- Rollback: DELETE FROM fx_rates WHERE base_currency = 'USD' (only before any USD case exists).

INSERT INTO fx_rates (currency, base_currency, rate, rate_date) VALUES
('USD', 'USD', 1, '2026-01-01'),
('EUR', 'USD', 1.087, '2026-01-01'),
('GBP', 'USD', 1.272, '2026-01-01'),
('JPY', 'USD', 0.0067, '2026-01-01'),
('KWD', 'USD', 3.261, '2026-01-01');

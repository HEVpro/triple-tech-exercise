-- Fixed conversion rates used to normalise a case amount to the tenant's base currency,
-- so the stuck-queue report can order by money across currencies. The rate is
-- snapshotted onto the case at creation, so the report is reproducible.
-- This is a deliberate simplification for the exercise: a production system would source
-- rates from the scheme settlement feed or the bank's provisioning rates.
-- rate is expressed in major units: 1 unit of currency = rate units of base_currency.
-- Rollback: DROP TABLE fx_rates (only before any case exists).

CREATE TABLE fx_rates (
  currency CHAR(3) NOT NULL,
  base_currency CHAR(3) NOT NULL,
  rate NUMERIC(20, 10) NOT NULL,
  rate_date DATE NOT NULL,
  PRIMARY KEY (currency, base_currency),
  CONSTRAINT fx_rates_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT fx_rates_base_currency_check CHECK (base_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT fx_rates_rate_check CHECK (rate > 0)
);

INSERT INTO fx_rates (currency, base_currency, rate, rate_date) VALUES
('EUR', 'EUR', 1, '2026-01-01'),
('USD', 'EUR', 0.92, '2026-01-01'),
('GBP', 'EUR', 1.17, '2026-01-01'),
('JPY', 'EUR', 0.0062, '2026-01-01'),
('KWD', 'EUR', 3.0, '2026-01-01');

GRANT SELECT ON fx_rates TO triple_app;

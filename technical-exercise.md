## Take-Home Exercise: Dispute Case Platform

## Goal

Build a minimal dispute-case service from scratch so an issuer's operations team can work chargeback cases without missing a scheme deadline, and can reconstruct any case's history years later.

A case is always in one of: OPEN | UNDER_REVIEW | WON | LOST .

A dispute case consists of:

- external_ref (the bank's own case id)

- amount_cents

- currency

- scheme + reason_code

- presentment_date

- status

- (you add the rest)

## What We Value Most

- Bootstrapping: setting up a working project from scratch, quickly.

- Domain modeling: schema, migrations and rules a regulator could audit.

- API contracts: changes that don't break banks already integrated.

- Functionality over polish: no custom CSS or visual design needed. Use frameworks, libraries or component kits to get to a working result.

- AI use: using AI tools to develop fast and fill skill gaps.

## Scope

## Backend

- API to:

- Create and fetch a case.

- Transition status, with an audit trail.

- Fetch case history (as of a date).

- Run the stuck-queue report.

- Migration(s) you would run against live data for 60+ tenants.

## Frontend

- Not required.

- Optional: a one-page console (at-risk table + case history timeline) if it helps you think.


## Task Catalog (Business Rules)

- 1. Scheme Deadline ( deadline_rule )

- Purpose: a case must be filed before the scheme's response window closes.

- Logic: deadline_at = presentment_date + window(scheme, reason_code)

- Params: response windows. Defaults: Visa dispute 45d, Mastercard 45d, OTHER 30d.

- Business meaning: miss the deadline and the bank auto-loses. Windows are data, because schemes reissue them.

- 2. Audit Trail ( case_events )

- Purpose: answer "what was this case on day X, and who or what changed it?"

- Logic: every transition appends an event ( actor: human | agent , from , to , at , reason ); GET /cases/:id/history replays them.

- Business meaning: regulators and counterparties contest disputes months later. Banks consume GET /cases/:id , so keep it working.

- 3. Stuck-Queue Report ( queue_report )

- Purpose: show a bank where its dispute operation is losing money.

- Logic: per tenant, deadline_at <= now() + risk_window and status IN (OPEN, UNDER_REVIEW) , ordered by amount_cents DESC .

- Params: risk_window (default 7d).

- Business meaning: exposure sorted by money, not by age.

## Bonus: Operations

Optional: SLOs and alerts. What should page someone at 3am: a breached deadline, evidence filed late, a failed history write?

## Terminal Rules

Configurable, ordered rules that map events to a final status. Default:

- 1. Deadline passed → LOST (auto).

- 2. Evidence filed before deadline → UNDER_REVIEW .

- 3. Scheme records outcome → WON | LOST .

- 4. Else → OPEN .

## Deliverables

- Source code (backend), preferably in a single GitHub repository started from an empty initial commit, with the history left intact.

- Any language and tooling. One fixed constraint: the database is Postgres.

- README with:

- How to run the project.

- Example cURL/HTTPie commands.

- Your migration plan against live data.


- NOTES.md : how AI was used, and the agent transcript you actually ran (paste it or link to it). We care most about the prompts that failed and how you caught the bad output.

## Review Scenarios

We will test your solution with these inputs (default params):

- 1. Presentment 40 days ago, Visa, OPEN → at-risk (deadline in 5d).

- 2. Presentment 50 days ago, Mastercard, OPEN → breached.

- 3. A case with 400 events opened 2 years ago → history fetched in < 200ms.

- 4. A tenant with ~10M rows → report query returns in < 100ms, with EXPLAIN output.

We will spend our first 45 minutes debating the trade-offs behind these.

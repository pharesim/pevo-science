# Every HAF read that answers with a substitute when HAF cannot answer

**Owner:** architect
**Created:** 2026-10-06
**Priority:** normal

Filed from the architect review of `ui-accreditation-binding-refusal-states`, with the user's
direction (2026-10-06): HAF outages show an error with a retry, because without HAF data the site
cannot answer.

## Why

`ARCHITECTURE.md` "Data Source Policy", item 1 now says: when HAF cannot answer a read (no pool, a
query error, a timeout), the request fails with a retriable 503 (`details.retriable: true`) and the
SPA shows an error with a retry; no route substitutes an answer (an empty list, "not accredited",
"sanctioned"). Before, the policy allowed "empty results or errors", and the code has substitutes:
`backend/src/hafsql.ts` returns `[]` from several reads when `getPool()` is null, and
`getAccreditedSet` safe-fails to an empty set, which gated routes answer as 403. Some paths already
conform: the `HafQueryError` 503 class listed in `api-contracts/common.md` and the consented-layer
reads (`ARCHITECTURE.md`, consented layer).

## Scope

1. Inventory every HAF read (`getPool()` is the HAF pool; `getAppPool()` is the app database and
   out of scope) reachable from an SPA request: what it answers on no pool, a query error and a
   timeout; what the route then returns; what the SPA shows. Mark each conforms or substitutes.
2. File the fixes as backend tasks grouped by area, plus ui tasks where the SPA offers no retry
   for a 503. Priority `high` where the substitute reads as a refusal or a definitive negative
   about an account (sanctioned, not accredited, not found); `normal` for empty listings.
3. The sanction read is already filed: `backend-failed-sanction-read-is-not-a-sanction`.

## Out of scope

- Background jobs (WoT, reputation batches): they serve no request.
- Answers from a cache an earlier successful read filled: those are real answers.

## Method

`architect-audit-hafsql-and-chain-walkers` audits `hafsql.ts` and `chain-walkers.ts`; run this
inventory with it or after it, so the two do not file overlapping tasks.

## Done when

The inventory is recorded in this file, the accepted fixes are filed with a priority, the user has
triaged them, and the file is archived.

## Architect note (2026-10-09): two sites from the failed-sanction-read review

For the scope 1 inventory:
- `broadcastAccreditationAndSeed` (`backend/src/routes/signup-verify.ts`): on a signup carrying an
  ORCID, the sanction read can succeed while `findAccreditedAccountWithOrcid` throws; the throw
  reaches the activation-lock `onError` path, which answers 500, not a retriable 503.
- `POST /api/custody/broadcast` (`backend/src/routes/custody.ts`, event
  `custody.broadcast.idempotency_haf_unconfigured`): with HAF not configured it proceeds without
  the idempotency read. `POST /api/accreditation/verify` now answers a retriable 503 in that case.

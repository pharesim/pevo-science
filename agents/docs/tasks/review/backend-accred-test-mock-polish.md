# BE-ACCRED-TEST-MOCK-POLISH — Test-mock hygiene for accreditations route

**Owner:** backend
**Created:** 2026-04-21 (surfaced by BE-ACCRED-TX-ID-PARITY + BE-ACCRED-REVOKE-TEST archive review 2026-04-21c)
**Priority:** P3

## Context

All 4 items are test-mock hygiene that would surface as visible test failure under refactor. Not production risk, but worth a sweep before the next `accreditations.ts` refactor.

## Changes

1. **`backend/tests/routes/accreditations-revoke.test.ts:~44`** — `hafCache.clear()` in `beforeEach`.
2. **`backend/tests/routes/accreditations-revoke.test.ts:~47`** — multi-signal mock SQL detection mirroring the SEC-003-BE round-2 pattern.
3. **`backend/tests/routes/accreditations-revoke.test.ts:~61`** — comment edit on `event_id: null` fixture (defensive signaling, not active coverage).
4. **`backend/src/routes/accreditations.ts:~141`** — `payload.orcid || null` → `payload.orcid ?? null`. Operator precision.

## Non-goals

Extracting a `withCleanCache()` test helper. Refactoring the accreditations.ts CTE shape.

## Implementation notes

Landed at commit **4dae6a9** ("BE-ACCRED-TEST-MOCK-POLISH: polish revoke-branch test mock and orcid null coalescing"). 1/1 pass in `accreditations-revoke.test.ts` + 3/3 pass + 1 skipped in `accreditations.test.ts` (smoke-check for the `??` change); full backend vitest 39 files / 268 pass.

- **`backend/tests/routes/accreditations-revoke.test.ts:42-48`** — `hafCache.clear()` added in `beforeEach`. Cache bleed between sibling tests closed.
- **`backend/tests/routes/accreditations-revoke.test.ts:64-67`** — multi-signal mock SQL detection. Guard now requires both `sql.includes("'action' IN ('accredit', 'revoke')")` AND `sql.includes('FROM hafsql.operation_custom_json_view')`. Note: task spec suggested `FROM customjsonops`, but the route SQL uses `T.customJson` which resolves to `'hafsql.operation_custom_json_view'` per `backend/src/hafsql.ts:46`. Implementer used the real literal. Mirrors the SEC-003-BE round-2 pattern in `backend/tests/routes/claims.test.ts:95`.
- **`backend/tests/routes/accreditations-revoke.test.ts:68-77`** — `event_id: null` fixture comment rewritten as defensive signaling, not active coverage.
- **`backend/src/routes/accreditations.ts:141`** — `payload.orcid || null` → `payload.orcid ?? null`. Operator precision, no behavior change today.

## [TODO Architect]

None. Self-contained.

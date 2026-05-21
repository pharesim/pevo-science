# BACKEND-RETRACT-REAL-PATH-VERIFYHIVESIGNATURE-TEST — add real-path verifyHiveSignature companion test for /retract per MOCK_VERIFY_SIGNATURE carve-out clause (b)

**Owner:** backend
**Created:** 2026-05-21 (architect, surfaced by `/ce-code-review` on `backend-custody-limiter-cpu-amplification-mitigation` round-2 — project-standards PS-R2-01 P1 anchor 75)
**Priority:** P2

## Problem

`backend/tests/routes/papers-retract-url-shape-validator.test.ts` (added in round-2 of `backend-custody-limiter-cpu-amplification-mitigation`) uses the `MOCK_VERIFY_SIGNATURE` fixture from `backend/tests/fixtures/mock-auth.ts`. The file header invokes the test-mock carve-out and cites `papers-haf-error-vs-not-found.test.ts` and `retract.test.ts` as real-path companions for clause (b) of root CLAUDE.md "Running Tests". Both cited companions also use `MOCK_VERIFY_SIGNATURE`. No test in the repository exercises the real `verifyHiveSignature` middleware against signed requests to `POST /api/papers/:author/:permlink/retract` (or any sibling route in `papers.ts`).

Per root CLAUDE.md carve-out clause (c): "the real-path companion does NOT need to assert the same thing as the mocked test, only to exercise the integrated path with real infrastructure so a different mutation class is caught." Clause (b) requires the companion to exist for the same route or a sibling within the same router. The carve-out documentation also permits "OR a follow-up task is filed to add such coverage" — this task is that follow-up.

## Why now

Pre-launch readiness item. The convention's purpose is to ensure cryptographic verification is not silently skipped from the codebase by repeated use of the fixture across files. Closing the gap removes a class of regressions where a refactor to `verifyHiveSignature` (key-rotation handling, ed25519 support, session-token-vs-signature precedence) could land without any real-path test for the `/retract` route catching it.

## Goal

Add at least one integration test exercising the real `verifyHiveSignature` middleware against a signed request to `POST /api/papers/:author/:permlink/retract` (or a sibling route in `papers.ts` if `/retract` has prohibitive setup cost — but `/retract` is preferred since it's the route the carve-out citation gap is on).

## Acceptance

1. **New test file or new specs in an existing file** that import the real `verifyHiveSignature` middleware (NO `MOCK_VERIFY_SIGNATURE`) and exercise the integrated middleware chain against signed `X-Hive-Signature` headers.

2. **At least one positive spec** asserting a valid signed request reaches the handler (200 / 202 / 204 path, or an expected non-validation 4xx/5xx that exercises the handler logic post-auth).

3. **At least one negative spec** asserting a malformed / mis-signed / missing-signature request is rejected with the expected 401 from real `verifyHiveSignature`.

4. **Test file header** documents the test-mock carve-out compliance (this test IS the real-path companion the URL-shape-validator test cited). Update the header of `papers-retract-url-shape-validator.test.ts` to point at this new file as the real-path companion (replacing the current incorrect citations to other mock-using files).

5. **No new MOCK_VERIFY_SIGNATURE usage** in this test file — the test's purpose is precisely to exercise the real middleware.

## Coordination

- Independent of any other in-flight task. Landing this in parallel with `backend-custody-limiter-cpu-amplification-mitigation` round-3 does not interact with that hold's items.
- Companion under update: `papers-retract-url-shape-validator.test.ts` header citation must be updated after this test lands.
- Sibling reference: `backend/tests/routes/custody-upgrade.test.ts` exercises real `verifyHiveSignature` against custody routes — same pattern, different router. Read it for the canonical setup shape.

## Out of scope

- Migrating other `MOCK_VERIFY_SIGNATURE` usages in `papers.test.ts`, `retract.test.ts`, `papers-haf-error-vs-not-found.test.ts`. Those tests' focus is not auth; the existing fixture usage is correct per carve-out clause (a). Only the new real-path companion is required.
- Adding a second real-path test on a different `papers.ts` route. One is sufficient to close the convention gap.

## Source

`/ce-code-review` project-standards PS-R2-01 (P1 anchor 75, 2026-05-21) during round-2 architect review of `backend-custody-limiter-cpu-amplification-mitigation`. Triaged at architect session 2026-05-21 — routed to a follow-up task rather than held on the limiter task because (a) the carve-out explicitly permits "OR a follow-up task is filed", (b) adding a real-path test is its own meaningful chunk of work, (c) the load-bearing hold items on the limiter task are unrelated to this gap.

## Cross-references

- root CLAUDE.md "Running Tests" carve-out clauses (a), (b), (c)
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`
- `backend/tests/fixtures/mock-auth.ts` (MOCK_VERIFY_SIGNATURE definition)
- `backend/tests/routes/papers-retract-url-shape-validator.test.ts` (mocked sibling that cites this task's deliverable as its real-path companion)
- `backend/tests/routes/custody-upgrade.test.ts` (existing real-path pattern reference)
- `backend/src/middleware/verifyHiveSignature.ts` (middleware under test)
- `backend/src/routes/papers.ts` (route under test)

## Backend signal (2026-05-21)

Added `backend/tests/routes/papers-retract-real-path-verifyhivesignature.test.ts` — 8 specs exercising the real `verifyHiveSignature` middleware against `POST /api/papers/:author/:permlink/retract`:

- POSITIVE: valid signed request reaches the handler — 404 NOT_FOUND post-auth (proves verifyHiveSignature → validateRetractParams → retractLimiter → handler chain ran end-to-end).
- NEGATIVE: missing `X-Hive-Signature` header → 401 UNAUTHORIZED, chain mock never consulted, HAF query never fired.
- NEGATIVE: missing `X-Hive-Timestamp` header → 401 UNAUTHORIZED.
- NEGATIVE: malformed `X-Hive-Signature` (non-hex) → 401 UNAUTHORIZED.
- NEGATIVE: signature whose recovered pubkey is not in `posting.key_auths` → 401 UNAUTHORIZED.
- NEGATIVE: signature bound to a different body (body-tamper) → 401 UNAUTHORIZED.
- NEGATIVE: timestamp outside the 60s freshness window → 401 UNAUTHORIZED.
- NEGATIVE: cross-account spoof (header username doesn't match an on-chain account) → 401 UNAUTHORIZED.

Mock targets per carve-out clause (a): `hiveClient.database.getAccounts` (deterministic posting-key fixture, same approach as `verifyHiveSignature-authmethod.test.ts` and `custody-upgrade.test.ts`); `getPool()` (empty rows → 404 paper-not-found deterministically). `verifyHiveSignature` runs real — that is the focus of this file. Header citation in `papers-retract-url-shape-validator.test.ts` updated to point at this file as the real-path companion (replacing the dead citations to `papers-haf-error-vs-not-found.test.ts` and `retract.test.ts`, both of which also use `MOCK_VERIFY_SIGNATURE`).

Scoped vitest output: 2 test files, 13 tests, all passing (8 new + 5 existing URL-shape-validator). Typecheck + lint clean.

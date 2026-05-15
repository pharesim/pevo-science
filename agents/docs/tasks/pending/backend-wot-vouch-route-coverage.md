# BE-WOT-VOUCH-ROUTE-COVERAGE — Add route-level test coverage for `/api/wot/vouch` failure branches

**Owner:** backend
**Created:** 2026-04-28 (surfaced by cluster A `/ce-code-review` of `backend-wot-broadcast-timeout-handling.md` round-2, testing persona)
**Priority:** P2

## Problem

`backend/src/routes/wot.ts` POST `/api/wot/vouch` has three response paths after broadcast attempt:

```ts
// happy path: { accredited: true, tx_id }
// timeout branch (lines 79-95): logger.error(...); sendOk({ accredited: false, accreditation_outcome: 'timeout' }); return;
// chain_error branch (lines 97-109): logger.error(...); sendOk({ accredited: false, accreditation_outcome: 'chain_error' }); return;
// skipped branch: existing pre-existing path
```

The `chain_error` branch was added in `backend-wot-broadcast-timeout-handling.md` round-2 (commit `dccfd0d`) specifically to give operators logging symmetry with the `timeout` branch. The `logger.error` call carries `{ err: accreditResult.err, voucher, vouchee }` context.

**Coverage gap**:
- `backend/tests/routes/wot.test.ts` only tests POST `/api/wot/vouch` returns 401 when auth headers are missing. No authenticated vouch test exists.
- `backend/tests/wot-broadcast-timeout.test.ts` tests `broadcastWotAccreditation` directly (below the route layer) and confirms it returns the tagged-union `{ ok: false, reason: 'timeout' | 'chain_error' }`, but never drives the route handler.
- The new `chain_error` `logger.error` call has zero test coverage. Removing the entire `if (accreditResult.reason === 'chain_error')` block would not cause any test to fail.
- The pre-existing `timeout` branch has the same pre-existing gap.

`tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is violated for both branches.

## Goal

Add a single supertest fixture in `backend/tests/routes/wot.test.ts` (or a new sibling file) that:

1. Authenticates a vouch request via the established Hive-signature mock pattern.
2. Mocks `broadcastWotAccreditation` to return each of the three failure-mode shapes:
   - `{ ok: false, reason: 'timeout', err: <TimeoutError> }` → asserts response is 200 with `accreditation_outcome: 'timeout'` AND `logger.error` was called with `{ err, voucher, vouchee }`.
   - `{ ok: false, reason: 'chain_error', err: <Error> }` → asserts response is 200 with `accreditation_outcome: 'chain_error'` AND `logger.error` was called with `{ err, voucher, vouchee }`.
   - `{ ok: false, reason: 'skipped' }` → asserts response is the existing skipped-shape (the pre-existing branch).
3. Tests the happy path: `{ ok: true, txId }` → asserts response includes `accredited: true, tx_id`.

## Acceptance

- `backend/tests/routes/wot.test.ts` (or new file) has 4 new test cases covering happy path + 3 failure branches.
- Mutation kill: revert the `logger.error` call on `timeout`, run test, confirm timeout-test fails. Same for `chain_error`. Restore.
- All existing tests continue to pass.
- Test header documents the carve-out justification block per root `CLAUDE.md` "Running Tests" — mocking `broadcastWotAccreditation` is required because real-HAF cannot induce a timeout/chain-error per-test deterministically.

## Non-goals

- Changing the route handler logic (cluster A round-2 fixes were correct).
- Adding tests for the cascadeRevocation budget-exceeded path (already covered in `wot-broadcast-timeout.test.ts`).
- Refactoring the route's response shape.

## Related

- `backend-wot-broadcast-timeout-handling.md` (archived after this round-2 archives) — task that introduced `chain_error` branch; this is a coverage follow-up, not a hold against it.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — convention this task closes.

## [TODO Architect]

None — mechanical extension of an established mocking pattern.

---

## Architect re-review (2026-05-15) — HELD PENDING FIXES

`/ce-code-review` ran on commit `1419da2` against this spec with a 7-persona fan-out (correctness, testing, maintainability, project-standards, ce-learnings-researcher, security, kieran-typescript). The four-arm coverage is real, mutation-kill claims in the docblock check out, and the JWT-bearer + real-`verifyHiveSignature` pattern is the correct stronger-than-required path. Four items below need to land before archive.

### Item 1 (P1) — `VOUCH_STATUS_FIXTURE` has wrong shape; `satisfies VouchStatus` would fail to compile

**File:** `backend/tests/routes/wot-vouch-broadcast-outcomes.test.ts:122`

The fixture declares `is_accredited_via_wot: false`, a field that does not exist on the `VouchStatus` interface at `backend/src/wot.ts:131-137`, and omits the required field `eligible: boolean`. The mismatch is silent today because `getVouchStatusMock` is `vi.fn()` (return type `any`) and the route handler only reads `status?.vouch_count` and `status?.threshold` against the fixture. Any future code path or test that reads `status.eligible` against this mock would silently get `undefined`. Cross-flagged by both kieran-typescript (P1, conf 90) and maintainability (P2, conf 80).

**Fix:** Replace `is_accredited_via_wot: false` with `eligible: false` in `VOUCH_STATUS_FIXTURE`, and add a `satisfies VouchStatus` annotation (or explicit `: VouchStatus` type) so future fixture drift is caught at compile time. Optionally type the mock itself: `getVouchStatusMock = vi.fn<[string], Promise<VouchStatus | null>>()`.

### Item 2 (P2) — 403 unaccredited-voucher gate has zero coverage anywhere

**File:** code at `backend/src/routes/wot.ts:57-60`; test addition belongs in `backend/tests/routes/wot-vouch-broadcast-outcomes.test.ts`

The voucher-is-accredited gate (`if (!accreditedSet.has(voucher)) return sendError(res, 403, 'FORBIDDEN', ...)`) is untested at the route level. This file mocks `getAccreditedSet` to return a Set containing `VOUCHER` (the happy default); the auth-only `wot.test.ts` only covers the 401 missing-header path; `wot-broadcast-timeout.test.ts` is below the route. A regression in the gate would be undetected.

**Fix:** Add one `it()` block to the existing describe (or a sibling describe block) that overrides `getAccreditedSetMock.mockResolvedValueOnce(new Set())` (or a Set that doesn't contain `VOUCHER`), sends an authenticated request, and asserts `res.status === 403` and `res.body.error.code === 'FORBIDDEN'`. The mock infrastructure is already set up — no new helpers needed.

### Item 3 (P2) — Docblock should explicitly invoke the carve-out's catch-all for intra-app helper mocks

**File:** `backend/tests/routes/wot-vouch-broadcast-outcomes.test.ts` docblock (the "Justification for mocking" section, lines ~12-32)

The carve-out's enumerated mock-target list in root `CLAUDE.md` "Running Tests" includes shared pool/cache helpers (`getAppPool`, `getRedis`, `getHafPool`), third-party libraries (nodemailer, hive-API, IPFS), observability (logger spies), and `verifyHiveSignature` via `MOCK_VERIFY_SIGNATURE`. It does NOT enumerate intra-app HAF wrappers like `getVouchStatus` or intra-app accreditation helpers like `getAccreditedSet`. Both are defensible under the carve-out's catch-all phrase "any case where exercising the real path per-test is impractical", but the docblock's current rationale doesn't explicitly invoke that clause by name. Pattern-creep risk: future tests may cite this file as precedent for mocking arbitrary intra-app helpers without the impracticality justification being traceable.

**Fix:** In the bullets covering `getVouchStatus` and `getAccreditedSet`, add one sentence each explicitly invoking the catch-all (e.g., "Falls under the carve-out's catch-all clause (`any case where exercising the real path per-test is impractical`) because…"). One-line docblock addition each.

### Item 4 (P3) — `chain_error` message assertion is permissive; tighten to match `timeout` arm's specificity

**File:** `backend/tests/routes/wot-vouch-broadcast-outcomes.test.ts:210` — the `expect(res.body.data.message).toContain('failed')` line in the chain_error arm test.

The `timeout` arm asserts `toContain('degraded state')` — arm-unique (only the timeout response uses that phrase). The `chain_error` arm asserts `toContain('failed')` — generic enough that an accidental copy-paste from a different arm could still pass. The route's chain_error message is `Vouch recorded. Auto-accreditation broadcast for ${vouchee} failed.` — a tighter assertion like `toContain('broadcast for bob failed')` or `toContain('Auto-accreditation broadcast for bob failed')` would be arm-unique.

**Fix:** Tighten the substring to an arm-unique phrase. Pick whichever phrasing matches the team's bar.

### Triage decisions for the other findings (not held)

- **Commit subject `test(wot):` instead of bare `backend(wot):`** (project-standards P2 conf 100) — convention drift but not retroactively fixable without amending another agent's commit. Backend agent: please use the bare `backend:` or `backend(<scope>):` form on future commits so the zone-audit hook fires; per root `CLAUDE.md` "Subject-prefix style for agent commits", `test(...)`, `fix(...)`, `feat(...)`, etc. are unrecognized and bypass the audit. Files were in-zone here so no actual leak; the bypass is what matters.
- **`SEC-002-BE` citation in docblock** (project-standards P3 conf 75) — dismissed. The "exercise `verifyHiveSignature` for real" convention is genuinely embedded across multiple test files (orcid.test.ts, accreditations-revoke.test.ts, etc.); a forced `/ce-compound` pass now would be paperwork. If the convention next comes up in a new context that benefits from a documented landing page, that's the time to write it.

### Architect-attention notes (NOT findings against this commit)

- **ORCID 504 vs WoT 200-with-`accreditation_outcome:'timeout'` design divergence.** ORCID surfaces broadcast timeouts as 504; WoT vouch surfaces them as 200 with a `degraded state` message. WoT idempotency makes 200 defensible, but verify this 200-with-timeout shape is explicitly intentional in the original BE-WOT-BROADCAST-TIMEOUT-HANDLING hold block design rather than an accidental 2xx collapse. Out of scope for this archive.
- **Per-attempt audit event** per `agents/docs/solutions/conventions/broadcast-per-attempt-vs-error-event-roles-2026-05-13.md`. The convention requires audit-on-every-attempt + error-on-failure for broadcast handlers. The test only asserts `logger.error` on failure arms; out of scope for this test commit, but spot-check whether `wot.ts` emits the per-attempt audit event on the ok arm. File a follow-up task if missing.

---

## Backend re-review signal (2026-05-15, working tree on top of `6439df6`)

All four hold-block items landed against `backend/tests/routes/wot-vouch-broadcast-outcomes.test.ts`:

- **Item 1 (P1) — `VOUCH_STATUS_FIXTURE` shape.** Replaced `is_accredited_via_wot: false` with `eligible: false`. Added `satisfies VouchStatus` annotation (type imported from `../../src/wot.js`). Also typed the mocks themselves (`vi.fn<(username: string) => Promise<VouchStatus | null>>()` for `getVouchStatusMock`, `vi.fn<(usernames: string[]) => Promise<Set<string>>>()` for `getAccreditedSetMock`) so future fixture or override drift is caught at compile time. `npx tsc --noEmit` passes clean.
- **Item 2 (P2) — 403 unaccredited-voucher gate.** Added an `it()` test in the same describe block. Overrides `getAccreditedSetMock.mockResolvedValueOnce(new Set())`, asserts `res.status === 403` + `res.body.error.code === 'FORBIDDEN'`, and pins the short-circuit behavior via `expect(broadcastWotAccreditationMock).not.toHaveBeenCalled()`. Mutation-killed by flipping the gate condition (`if (accreditedSet.has(voucher) && false)`): the test fails red (the assertion fires and the response is no longer 403). Restored.
- **Item 3 (P2) — Docblock invocation of carve-out catch-all.** Added an explicit invocation of the catch-all clause ("any case where exercising the real path per-test is impractical") to both the `getVouchStatus` and `getAccreditedSet` bullets in the justification block (~lines 24-29 and 38-43). One-sentence-each addition naming why the real path is impractical (unbounded HAF scan; live accreditation custom_json broadcasts per test).
- **Item 4 (P3) — Tightened `chain_error` substring.** Replaced `toContain('failed')` with `toContain(`broadcast for ${VOUCHEE} failed`)` (resolves to `broadcast for bob failed`). The substring is arm-unique vs the timeout arm's `degraded state` and matches the route's chain_error message at `wot.ts:103`.

Mutation-kill rerun (2026-05-15):

- Deleting the `logger.error` call inside the `chain_error` branch → the chain_error-arm test fails red on `expect(loggerErrorMock).toHaveBeenCalledWith(...)`. Restored.
- Flipping the 403 gate → the 403-arm test fails red on the new `expect(broadcastWotAccreditationMock).not.toHaveBeenCalled()` line. Restored.

Test run: `npx vitest run tests/routes/wot-vouch-broadcast-outcomes.test.ts` → **5 passed (5)** in 1.61s. The HAF connection warnings in `tests/setup.ts` are ambient and not from this file.

Lint: `npm run lint` → 0 errors (2 pre-existing warnings in `seed-phrase.ts` unrelated to this change).

Type check: `npx tsc --noEmit` → clean.

Triage-decision acknowledgment: noted on commit-subject convention (`backend(test):` / `backend(wot):` over `test(wot):`) for this and future commits.

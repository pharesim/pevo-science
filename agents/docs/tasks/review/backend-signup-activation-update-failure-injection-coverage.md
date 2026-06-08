# BACKEND-SIGNUP-ACTIVATION-UPDATE-FAILURE-INJECTION-COVERAGE — end-to-end test for createClaimedAccount→UPDATE-fails→retry→resumeChainExists transition

**Owner:** Backend Agent
**Created:** 2026-05-30 (architect, surfaced by `/ce-code-review` of `backend-signup-activation-failure-recovery-and-pool-hold` round-1)
**Priority:** P2 (test infra)

## Problem

The `backend-signup-activation-failure-recovery-and-pool-hold` redesign closes Facet 1's "recovery gap" by adding a `resumeChainExists` path: if `verify_token` is still set AND `getAccounts` confirms the chain account already exists on retry, the handler resumes activation (encrypts keys + clears `verify_token`) WITHOUT re-broadcasting `createClaimedAccount`. The acceptance criterion is: "A failure between `createClaimedAccount` success and durable activation leaves the user recoverable: a retry resumes activation without re-broadcasting, with no permanent 409 lockout and no second claim-token burn."

The existing test `signup-verify-activation-recovery.test.ts` covers the **resume path's behavior** by seeding a post-crash row state directly (a row with `verify_token` still set, `posting_key_enc` NULL, simulating "broadcast landed, UPDATE failed mid-flight") and then driving `/confirm` on that pre-seeded row. The test verifies the resume path correctly skips re-broadcast and finalizes the row.

What's NOT covered: the **actual failure transition** that produces the post-crash row state. The current scaffold has no way to inject a UPDATE failure mid-broadcast — you can't easily say "let `createClaimedAccount` succeed, then make the post-broadcast UPDATE throw, then retry and verify the resume path catches it." The test currently fast-forwards over the failure transition by setting up the post-state directly. A regression in the failure path's interaction with the resume path (e.g., a refactor that moves the UPDATE before the broadcast, or changes the row state the failure leaves behind) wouldn't be caught by the current seeded-state test.

## Goal

Add an end-to-end test that drives the actual failure transition: `createClaimedAccount` succeeds (mock resolves with a normal `block_num`), then the post-broadcast `UPDATE accounts SET ...` fails (injection seam), the handler responds with a 500 or 502, then a retry hits `resumeChainExists` and finalizes the row.

The blocker is a missing test seam: there's no current way to inject a UPDATE failure mid-broadcast. Options:
- A mock seam at the pool boundary that wraps `pool.query` and rejects on a SQL match against the post-broadcast UPDATE shape (the existing tests already do this kind of injection for other purposes — verify the existing scaffold can extend cleanly).
- A pg `statement_timeout` shim that fires only on the UPDATE statement (more brittle, depends on statement ordering).
- A dedicated test seam exposed by the production code (e.g., a `__test_seams.failPostBroadcastUpdate(token)` hook gated behind `NODE_ENV === 'test'`). Pattern: `backend/src/routes/anonymousReview.ts`'s `__test_seams` export, gated by the project's ESLint rule that forbids importing them from production source.

Implementer's call on which seam shape; the load-bearing property is "the test exercises the actual failure-to-recovery transition end-to-end, not pre-seeded post-crash state."

## Acceptance

1. **End-to-end transition test in `signup-verify-activation-recovery.test.ts`** (or a new sibling file if the existing scaffold's mock setup doesn't extend cleanly):
   - Setup: pre-finalize state-F row + valid signup-binding cookie + posting_private.
   - Drive `/confirm` with `createClaimedAccount` mock that resolves successfully (returns `{block_num: N}`) AND a UPDATE failure injection that fires after the broadcast.
   - First request: returns 500 (or 502, whatever the actual cascade produces); the row state post-failure has `verify_token` still set + `posting_key_enc` NULL + the on-chain account materialized (verifiable via the `getAccounts` mock).
   - Retry the same request with the same auth_token + binding cookie + posting_private.
   - Assert: `createClaimedAccount` called EXACTLY ONCE across both requests (single-fire preserved across the failure transition); the retry response is 200; the row finalizes (`verify_token` NULL, `posting_key_enc` populated); no second claim-token burn (which the once-call assertion already pins).

2. **Mutation-kill:** revert the resume path's `verify_token IS NOT NULL` check OR the `chain-account-exists` check OR the skip-re-broadcast branch → the test goes RED. Document the mutation-kill in the test comment.

3. **Anchor discipline:** no slug/SHA/line/round-N/§ anchors in the test or new seam. Comments anchor on `resumeChainExists`, `createClaimedAccount`, `signup-verify`'s handler entry, or the route path.

4. **Coexists with existing tests.** The new test doesn't disturb the existing pre-seeded post-crash recovery tests — they cover the resume-path branch's logic in isolation; this new test covers the integrated transition. Both flavors stay in the suite.

5. **Carve-out clause discipline.** If the test mocks the pool boundary, the file-header carve-out clauses (a)/(b)/(c) per CLAUDE.md must be added/updated to document the new mocked target. Real-path companion: confirm the existing real-Postgres signup-verify tests cover the integrated path under normal (non-failure) conditions; they do — those satisfy clause (c).

## Out of scope

- Other untested failure paths in the activation cascade (e.g., `encryptKey` failure on the resume path itself, `BroadcastTimeoutError` mid-broadcast). Those are separate test gaps; one task per concern keeps the seam decisions decoupled.
- Any production-code change beyond adding the test seam (if a seam is needed). The activation handler logic stays as-is.
- Refactoring the test scaffold beyond what's needed to support the new injection.

## References

- `backend/src/routes/signup-verify.ts` — `/confirm` handler (`resumeChainExists` branch).
- `backend/src/lib/signup-activation-lock.ts` — the lock that wraps the broadcast.
- `backend/tests/routes/signup-verify-activation-recovery.test.ts` — existing seeded-state recovery tests.
- `backend/src/routes/anonymousReview.ts` `__test_seams` — reference pattern for a production-side test seam if that approach is chosen.
- `backend/eslint.config.mjs` — `no-restricted-imports` rule that blocks production imports of `__test_seams` (extend the rule to the new seam if added).
- 2026-05-30 architect `/ce-code-review` of `e48b1d60` — testing-gap (e) (correctness reviewer + testing reviewer convergence): "no end-to-end test for createClaimedAccount-succeeds-then-UPDATE-fails → catch → finally → retry → resumeChainExists. The activation-recovery test seeds the post-crash row state directly rather than driving the actual failure transition."
- Parent task `backend-signup-activation-failure-recovery-and-pool-hold` — round-1 hold finding #6's note that test gaps a/b/c are folded into their coupled hold items and d (TTL-expires-mid-holder) is folded into the hold round, leaving e as the separate task this file covers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend completion note (2026-06-08)

End-to-end failure-transition test added; drives the real crash, not a pre-seeded row.

- **Seam (production-side, gated):** `__test_seams.failNextFinalizeUpdate(authToken)` in `signup-verify.ts` arms a one-shot, per-`auth_token` failure that `maybeThrowInjectedFinalizeFailure` raises on the fresh path AFTER `createClaimedAccount` lands but BEFORE the finalize `UPDATE` — leaving the row exactly as a real mid-finalize crash would (verify_token set, posting_key_enc NULL, chain account materialized). It propagates through `withSignupActivationLock`'s catch to the route `onError` → 500. Gated by `process.env.VITEST || NODE_ENV === 'test'` (mirrors the existing `drainArgon2Queue` guard); a no-op in production. No pg pool mock added — the pool stays real, so no carve-out clause was needed for a pool mock; the file header carve-out was updated to document the new `__test_seams` injection.
- **Test:** new `describe` in `signup-verify-activation-recovery.test.ts` drives request 1 (fresh path, injected failure → 500, `createClaimedAccount` called once, row still recoverable) then request 2 (chain now exists → `resumeChainExists` → 200, `createClaimedAccount` still called EXACTLY ONCE = no second claim-token burn, row finalized: verify_token NULL, posting_key_enc populated).
- **Mutation-kill (documented in the test comment):** RED if any resume-path guard is reverted — the by-`verify_token` retry re-find (retry falls to the no-row 400), the chain-account-exists check (retry re-broadcasts → once-call fails), or the `if (!resumeChainExists)` skip-re-broadcast branch (retry re-broadcasts → once-call fails).
- **ESLint:** `no-restricted-imports` in `eslint.config.mjs` extended to forbid production imports of the new `__test_seams` (mirrors the anonymousReview guard); rule verified to fire against a probe import.
- **Verification:** implemented by a worktree subagent (commit cherry-picked to main); parent ran the file against real Postgres — 7/7 green. `npm run typecheck` + `npm run lint` clean.

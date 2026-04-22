# BE-WOT-BROADCAST-TIMEOUT-HANDLING — Surface partial-cascade state and avoid silent-drop on WoT broadcast timeouts

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-BROADCAST-ABORT-TIMEOUT first-review)
**Priority:** P2

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` wrapped `hiveClient.broadcast.json` with a 30s abort. First-review surfaced two web-of-trust-specific reliability gaps at `backend/src/wot.ts`:

1. **`broadcastWotAccreditation` returns `null` on any broadcast error including timeout.** Caller proceeds as if accreditation succeeded. A timeout silently drops an accreditation with no caller-level signal. (F4.5, reliability 0.80.)

2. **`cascadeRevocation` loops serially with per-iteration 30s timeouts and no aggregate wall-clock cap.** A degraded Hive node against K cascades holds for up to K × 30s. Each iteration's `try/catch` swallows `BroadcastTimeoutError` and continues, leaving that vouchee un-revoked with no retry path. If the root revocation is fraud-driven, the missed cascade is a live integrity gap. (F4.4, reliability + adversarial ADV-BCAST-004 0.85.)

Both are WoT-specific and share the same underlying shape: the timeout-helper surfaces errors, but `wot.ts` callers flatten them into silent success or silent skip, defeating the timeout's signal.

See `.context/compound-engineering/ce-code-review/aggregated/04-backend-orcid-broadcast-abort-timeout.md` § F4.4, F4.5.

## Goal

Make WoT broadcast outcomes observable and recoverable.

1. **`broadcastWotAccreditation` return type change.** Return `{ ok: true, txId: string } | { ok: false, reason: 'timeout' | 'chain_error' | 'skipped'; err?: Error }` instead of `string | null`. Callers explicitly branch on the discriminator; an `ok: false, reason: 'timeout'` result surfaces to the caller (vouch handler) which should either surface a degraded-state warning to the user or queue a retry.

2. **`cascadeRevocation` aggregate wall-clock cap.** Track elapsed time across the cascade loop; abort the loop with a `PartialCascadeError` (carrying the list of completed vs. pending revocations) if the aggregate exceeds a budget (e.g., 60s). Caller persists the pending list for a retry queue or operator intervention.

3. **Per-vouchee timeout observability.** A `BroadcastTimeoutError` in the cascade loop logs at `logger.error` (not `logger.warn`) with the root revocation + the pending vouchee's identity, so operators can manually re-revoke if the cascade dropped.

## Non-goals

- Full retry queue / outbox implementation. This task surfaces and logs; retry infra is separate.
- Changing the 30s per-broadcast timeout from `BE-ORCID-BROADCAST-ABORT-TIMEOUT`.
- Cross-coupling with `BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` — that task handles the ORCID-binding ambiguous-outcome window; this task handles wot-specific degraded-accreditation / partial-cascade state. Similar shape, different domain.

## Acceptance

- `broadcastWotAccreditation` returns the tagged-union shape; callers updated.
- `cascadeRevocation` has an aggregate budget + surfaces partial-cascade state.
- Tests cover (a) single-broadcast timeout → `ok: false, reason: 'timeout'`, (b) cascade with 3 vouchees, middle one times out → remaining two still revoked OR the cascade aborts with a list of pendings (per chosen semantic), (c) aggregate budget exceeded → `PartialCascadeError`.
- Log tier for broadcast failure is `logger.error` with `{ err, orcidId/username, vouchee, rootRevocation }` context.

## [TODO Architect]

- Whether partial-cascade state should be persisted (DB row, Redis queue) vs. just logged. Lean: log-only for now; file a follow-up for persistent retry queue once operator demand is clear.

## Backend re-review signal (2026-04-22, worktree-agent-a8c0ade0)

Landed:

- `broadcastWotAccreditation(vouchee)` added with tagged-union return
  `{ ok: true, txId } | { ok: false, reason: 'timeout' | 'chain_error' | 'skipped', err? }`
  in `backend/src/wot.ts`. `'skipped'` covers all the former `null` paths
  (admin key missing, not eligible, already accredited, pool unavailable).
  `'timeout'` fires only on `BroadcastTimeoutError`; every other throw maps to
  `'chain_error'` with the underlying `err` preserved. `checkAndAccreditViaWot`
  retained as a `@deprecated` thin shim returning `string | null` (no remaining
  callers in repo but kept for safety; archive pass can drop if preferred).

- `cascadeRevocation` now takes an optional internal `deadlineMs` so the
  top-level call stamps one deadline that recursive descendants inherit. The
  loop checks `Date.now() >= deadline` before each vouchee and throws
  `PartialCascadeError { completed, pending, rootRevocation }` when exceeded.
  Nested `PartialCascadeError`s are caught, their progress folded into the
  outer aggregate, and re-thrown with the outer depth-0 `rootRevocation`.
  `CASCADE_BUDGET_MS = 60_000` is exported.

- **Cascade semantics chosen: continue-on-timeout-until-budget.** A single-
  vouchee `BroadcastTimeoutError` is logged at `logger.error` with
  `{ err, vouchee, rootRevocation }`, appended to `pending`, and the loop
  continues. The cascade only aborts when the aggregate wall-clock budget
  is exhausted. Rationale: a single 30s hang doesn't justify abandoning the
  remaining vouchees. The per-vouchee error log gives operators a paper
  trail for manual re-revocation, and the budget prevents K cascades from
  holding the route handler for K*30s.

- `backend/src/routes/wot.ts` vouch handler branches on the tagged union:
  happy path returns `accredited: true, tx_id`; `timeout` returns
  `accredited: false, accreditation_outcome: 'timeout'` plus a degraded-
  state message (no blind retry); `chain_error` returns
  `accredited: false, accreditation_outcome: 'chain_error'`; `skipped`
  returns the old "N/M vouches" message. Retract handler catches
  `PartialCascadeError`, folds `completed` into `revocations`, and adds a
  `partial_cascade: { completed, pending, root_revocation }` field on the
  response.

- Tests: `backend/tests/wot-broadcast-timeout.test.ts` (5 new). Covers
  (a) single-broadcast timeout → `ok: false, reason: 'timeout'`; also
  chain-error and happy-path variants for completeness. (b) 3-vouchee
  cascade with the middle one timing out → `completed = ['tx-v1', 'tx-v3']`,
  3 broadcasts attempted, v2 logged at error and skipped. (c) aggregate
  budget exceeded via `vi.setSystemTime` jump after v1 succeeds →
  `PartialCascadeError` with `completed: ['tx-v1']`,
  `pending: ['v2', 'v3', 'v4']`, `rootRevocation: 'boss'`. File header
  documents the mocked-pool + mocked-`broadcastJsonWithTimeout` carve-out
  per root CLAUDE.md.

- All 11 tests across `tests/wot-broadcast-timeout.test.ts`,
  `tests/routes/wot.test.ts`, and `tests/hive-broadcast-timeout.test.ts`
  pass. `tsc --noEmit` clean. `npm run lint` shows only the 6 pre-existing
  `no-explicit-any` warnings in unrelated files.

Deferred / notes for architect:

- **Persistent retry queue deferred pending operator demand.** Per the
  task's [TODO Architect] lean, partial-cascade state is log-only for this
  pass. The `partial_cascade` response field plus `logger.error` entries
  give operators enough signal to re-run revocations manually. Please ack
  so we can archive. If a Redis/DB outbox follow-up task is wanted, say so
  during re-review.

- `checkAndAccreditViaWot` shim kept for safety since the task said to
  "update every caller" and there are none left in the repo. Flagged
  `@deprecated`. Delete freely during archive if preferred.

- `accreditation_outcome` field on the vouch response and `partial_cascade`
  field on the retract response are new. `agents/docs/api-contracts/` may
  need updates. [TODO Architect] per backend CLAUDE.md — contract edits are
  architect-owned; I did not touch the contract file.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commits `4966a5a` + `3d9362c` merge (correctness persona). Tagged-union shape on `broadcastWotAccreditation`, `PartialCascadeError` with aggregate budget, and continue-on-timeout-until-budget semantic all correct. One reviewer finding (C1, multi-level rootRevocation) traced as false-positive by architect — see dismissal below. Three P3 in-scope hygiene items for round-2.

1. **P3 — `result.rows.indexOf(row)` identity-based lookup is fragile to future pg driver changes** (correctness C2 0.88). `backend/src/wot.ts:~322` budget-exceeded branch calls `result.rows.indexOf(row)` where `row` is the for-of iteration variable. Safe today; if a future driver version clones rows, `slice(-1)` returns only the last element → silent truncation of the pending list. Fix: restructure with `.entries()`: `for (const [i, row] of result.rows.entries()) { ... const remainingRows = result.rows.slice(i); ... }`. Documents intent + removes identity assumption.

2. **P3 — `chain_error` branch in vouch handler doesn't log `err` with voucher context** (correctness C3 0.85). `backend/src/routes/wot.ts:~97` returns the error response without calling `logger.error({ err: accreditResult.err, voucher, vouchee }, 'wot vouch chain error')`. Sibling `timeout` branch at :82 correctly logs with voucher context. Fix: add the matching logger.error call. Closes route-layer observability asymmetry.

3. **P3 — `@deprecated checkAndAccreditViaWot` shim: lint doesn't enforce `@deprecated`; editor-only** (correctness C4 0.95). ESLint config has no `no-deprecated` rule; `tsc --noEmit` is silent. Implementer signal says "no remaining callers in repo but kept for safety; archive pass can drop if preferred." Fix: delete the shim (no callers → no safety net value; future callers would get a compile error against the new tagged-union return, which is the better forcing function than an editor-hover hint).

**Dismissed from round-1 findings (architect triage):**
- **C1 (correctness 0.92) — `rootRevocation` wrong in multi-level cascades:** FALSE POSITIVE. Reviewer traced through depth=1 folding but missed the depth=0 re-stamp at line 389 (`depth === 0 ? revokedAccount : nestedErr.rootRevocation`). Final PartialCascadeError emitted to the caller always has `rootRevocation = <depth-0 revokedAccount>` because the outermost depth's inner catch restamps. Intermediate stamps at depth ≥ 1 are mid-level accounts, but nothing logs them — per-vouchee logs at each depth use `{ vouchee, revokedAccount }` (this depth's own param, not the error's stamped value); the outer route handler logs the final error which always has the true root. Dismissed. Verified by direct code trace: `boss → v1 → x1 → y1` scenario with budget-exhaust at depth=2 produces `PartialCascadeError(rootRevocation='boss')` at the route handler, after intermediate stamps of 'x1' and 'v1' that are overwritten by the depth=0 re-stamp.
- Residual risk R2 (per-vouchee timeouts outside aggregate budget, N*30s if all time out): out-of-scope residual.

**Path to re-archive:** (1) Backend applies items #1-3 (restructure + logger.error + delete shim) on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2; archives on clean.

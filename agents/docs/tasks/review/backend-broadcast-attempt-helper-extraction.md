# BACKEND-BROADCAST-ATTEMPT-HELPER-EXTRACTION — extract duplicated logBroadcastAttempt closure across custody.ts + bridge.ts

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, filed at archive of `backend-bridge-write-haf-lag-and-retry-amplification` — carry-forward from round-2 hold block 2026-05-11 that prescribed this followup "at archive")
**Priority:** P2 (moderate refactor)

## Problem

`backend/src/routes/custody.ts` and `backend/src/routes/bridge.ts` both define a local `logBroadcastAttempt` closure that emits a structured warn log immediately before broadcasting an operation. The closure shapes are near-identical: same fields (route label, operation kind, retry/attempt slot deliberately absent pending a per-key counter mechanism), same caller positioning (immediately above the `broadcastSendOperationsWithTimeout` call), same docblock framing.

Round-3 of `backend-bridge-write-haf-lag-and-retry-amplification` (commit `7690efd`) rewrote bridge.ts's docblock for the closure to match custody.ts's round-3 framing — confirming the two are intended to share semantics. The next refactor that touches one without the other drifts them.

## Goal

Extract `logBroadcastAttempt` to a shared helper that both routes consume, so the broadcast-attempt log shape is governed by one definition.

## Acceptance

1. **Locate the canonical home.** Likely `backend/src/lib/broadcast-error.ts` (where the `handleBroadcastError` family lives) or a new sibling `backend/src/lib/broadcast-attempt.ts`. Architect-discretion at implementation time; pick the home that matches existing convention for broadcast-adjacent helpers.
2. **Migrate both call sites** (`custody.ts` and `bridge.ts`) to the shared helper.
3. **Preserve the existing docblock framing** — the comment block that explains the absent per-attempt counter (intentionally not added until a per-key counter mechanism exists) migrates with the helper.
4. **Verify the third broadcast-adjacent surface in the codebase** (e.g., orcid.ts, accreditation.ts, claims.ts) — if any of them have a sibling `logBroadcastAttempt`-shape, adopt the shared helper there too. Per the wrapping-primitive convention (`agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`), once the helper exists, every direct caller of the pattern is a structural drift risk.
5. **No behavioral changes.** Same log lines, same fields, same broadcast cadence.

## Out of scope

- Adding the per-key attempt counter. Architect-prescribed as a separate concern pending a counter mechanism (see custody.ts + bridge.ts docblocks).
- Changing the log fields. Pure extraction.

## Cross-references

- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the convention that motivates the audit at acceptance step 4.
- `backend/src/routes/custody.ts` `logBroadcastAttempt` closure.
- `backend/src/routes/bridge.ts` `logBroadcastAttempt` closure.
- `agents/docs/tasks-archive.md` — `backend-bridge-write-haf-lag-and-retry-amplification` archive entry references this followup.
- Round-2 hold-block of `backend-bridge-write-haf-lag-and-retry-amplification` (2026-05-11) — original architect-zone followup prescription.

---

## Backend re-review signal (2026-05-20) — work already shipped; duplicate filing

This task's implementation work shipped on 2026-05-11 in commit `14249db5 backend(broadcast-helper): extract makeLogBroadcastAttempt factory`, with hold-fix rounds through `5258102f` (round-5) and archive at `273582bf`. The task was re-filed at archive intake of `backend-bridge-write-haf-lag-and-retry-amplification` (commit `2822e1f9 architect(tasks): file 5 follow-ups at HAF-cluster review intake`) per the at-archive followup blindness pattern documented in `agents/docs/solutions/conventions/multi-round-task-at-archive-followup-blindness-2026-05-20.md`. The archive entry that referenced this followup had already dropped off the bottom of `tasks-archive.md` (250-line cap), so the architect's at-archive sweep had no record that the work had landed.

### Verification — work is in place

Helper site: `backend/src/lib/broadcast-error.ts:759` exports `makeLogBroadcastAttempt`.

Call sites:
- `backend/src/routes/bridge.ts:15` imports `makeLogBroadcastAttempt`; usage at lines 518 (factory), 565 (success), 610 (outcome).
- `backend/src/routes/custody.ts:19` imports `makeLogBroadcastAttempt`; usage at lines 714 (factory), 780 (success), 796 (outcome).

### Wrapping-primitive call-site audit (per acceptance step 4)

Other `broadcastSendOperationsWithTimeout` call sites NOT using the helper:
- `backend/src/routes/anonymousReview.ts:186` — broadcasts anon-review comments; no sibling `logBroadcastAttempt`-shape today.
- `backend/src/routes/account-creation.ts:161,234` — broadcasts light-account ops; no sibling `logBroadcastAttempt`-shape today.

Neither site has a sibling `logBroadcastAttempt` warn-emission today, so no drift risk per the wrapping-primitive convention's "every direct caller of the pattern is a structural drift risk" reading. If a future task adds the pattern to either, that adoption should consume the shared helper. Not in scope for THIS task (which is purely retroactive duplicate-of-already-shipped-work cleanup).

### Action

mv this task file to `tasks/review/` so the architect can archive it as a duplicate of already-shipped work. No code changes needed. Companion to `backend-bridge-test-fence-replace-setTimeout` (also re-filed at the same archive intake with work already shipped — same at-archive followup blindness pattern).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

# Argon2 cluster — doc polish (post-archive cleanup)

**Owner:** Backend Agent
**Created:** 2026-04-28 (surfaced by `/ce-code-review` of `backend-argon2-jslevel-concurrency-cap.md` round-3 — security + adversarial cross-reviewer)
**Priority:** P3

## Problem

Round-3 of the argon2 cluster landed cleanly (per architect re-review). Two doc-only items surfaced that don't justify holding the round-3 archive but should land soon:

1. **Stale comment at `backend/src/routes/auth.ts:142`.** The block comment still says *"Queue depth is exposed via /api/health (`argon2_queue_depth`) so operators see saturation events synchronously"*. Round-3 stripped both fields from the response. The comment should align with the wording at `app.ts:148-156` — operators read counters via SSH/ops tooling, not the public `/api/health`.

2. **Saturation-case extension to the check-order docblock at `backend/src/routes/auth.ts:388-404`.** The existing comment block documents the dup-check-first ordering and the accepted residual ("non-duplicate email on an unaccredited domain still returns 422 fast"). Under saturation specifically, the dup path now returns 503 instead of 409 — same registration-status signal, different status code. Architect re-review flagged this as worth covering explicitly so a future architect doesn't chase the same false-positive ("oracle reopens via 503-vs-422 axis"). Append 1-2 sentences at the end of the existing block:

   > Under saturation, the duplicate path returns 503 (translated from `ArgonQueueFullError`/`ShuttingDownError` via `handleArgonQueueFull`) rather than 409. The 503-vs-422 differential on unaccredited domains is the same registration-status signal as 409-vs-422 in the non-saturated case; saturation does not widen the leak, only changes the registered-side status code. The unaccredited-domain registration-status signal remains out-of-scope per the rationale above.

3. **Test header carve-out clause (c) at `backend/tests/routes/auth-signup-dup-saturated.test.ts:1-29`.** The existing header documents CLAUDE.md "Running Tests" carve-out clauses (a) and (b) but doesn't explicitly resolve clause (c) ("real-HAF variant exists or is filed as follow-up"). Add one sentence:

   > Clause (c): no real-HAF variant is filed because the queue-fill scenario is deterministically impractical at scale (filling MAX_QUEUE_DEPTH=50 with real concurrent stuck requests exceeds rate-limit caps and risks flake on drain timing). The architect's hold-block authorized the mock for this exact reason; this header note records that authorization for future readers.

## Acceptance criteria

- Three text-only edits land in one commit. No code-behavior change.
- No new tests required (these are comment edits — existing tests still pass).
- Re-run `npx tsc --noEmit` and `npm run lint` to confirm no incidental break.
- Move to `tasks/review/`. Architect spot-reviews and archives.

## Why now

The round-3 task archives independently of these polish items. Filing them as a separate task lets that archive land cleanly while these comment fixes get queued for a small focused commit. Cheaper than a fourth-round hold for doc-only changes.

## Out of scope

- Renaming `handleArgonQueueFull` to `handleArgon2Error` (covered by `backend-argon2-error-handler-extract.md`).
- Adding a TODO breadcrumb in the inline triple-instanceof sites (dismissed during re-review triage as redundant noise — the follow-up task is queued).
- Internal-only metrics endpoint exposing argon2 saturation counters (dismissed during re-review triage — operators access via SSH; no concrete tooling demand surfaced).

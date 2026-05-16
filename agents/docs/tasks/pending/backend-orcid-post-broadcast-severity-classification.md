# BACKEND-ORCID-POST-BROADCAST-SEVERITY-CLASSIFICATION — Classify `PostBroadcastWriteError` severity at orcid throw sites

**Owner:** backend
**Created:** 2026-05-11 (architect, batch-1 review triage — pre-existing finding)
**Priority:** P3

## Context

Round-2 of `backend-broadcast-idempotency-cluster-followup` added `severity: 'transient' | 'permanent'` to `PostBroadcastWriteError` (item F3) and routed `'permanent'` throws through a new 502 `POST_BROADCAST_OPERATOR_REQUIRED` HTTP code. The default severity is `'transient'` to preserve back-compat for existing callers.

The accreditation callers were updated in the same round to classify severity explicitly at each throw site. **orcid callers were NOT** — they continue to throw `new PostBroadcastWriteError(...)` without specifying severity. Per round-2's design intent, this is the deliberate back-compat preserve; the orcid retrofit was explicitly out of cluster scope.

But the orcid cascade functions (`seedAccreditationBonus`, `updateAccountOrcid`, etc., invoked from `routes/orcid.ts`) can throw genuinely permanent errors:
- `TypeError` / `SyntaxError` / `RangeError` from `getReputationWeights` or related coercion paths
- PostgreSQL 23xxx codes (constraint violations like unique-key conflicts)
- PostgreSQL 42xxx codes (undefined columns, malformed queries from schema drift)

When these throw, the propagated `PostBroadcastWriteError` uses the default `'transient'` severity, which `handleBroadcastError` interprets as:
- HTTP `POST_BROADCAST_FAILED` (502)
- User message "will reconcile automatically"

But it WON'T auto-reconcile. The underlying error is permanent (a TypeError from coercion is not transient; a constraint violation is not transient). The user is told to wait for self-recovery that will never happen.

Surfaced by correctness reviewer C1 in architect batch-1 review (conf 75, **pre-existing**). Pre-existing per protocol because the orcid throw paths predate the round-2 severity discriminator; the cluster scope explicitly excluded retrofitting orcid callers. This task is the retrofit.

Note conceptual coupling: cluster hold-block item 3 (in `tasks/pending/backend-broadcast-idempotency-cluster-followup.md`) fixes the user-facing message string for the cluster's `POST_BROADCAST_OPERATOR_REQUIRED` path. This task addresses a parallel-but-pre-existing surface (orcid) that benefits from the same severity discrimination AFTER the user-message fix lands.

## Acceptance

1. **Audit every `new PostBroadcastWriteError(...)` throw site in `backend/src/routes/orcid.ts`.** Grep for the constructor invocation and read each call site.
2. **For each throw site, decide severity at the call site:**
   - **`'permanent'` classification:** wrap the originating call in a `try { ... } catch (err) { ... }` and inspect `err`. If `err` is one of:
     - `TypeError`, `SyntaxError`, `RangeError` (programming errors)
     - PostgreSQL error with `err.code` matching `23xxx` (integrity constraint violation) or `42xxx` (syntax error / access rule violation)
     - Domain-specific permanent errors documented by the cascade fn
     then throw `new PostBroadcastWriteError(txId, err, failed_step, 'permanent')`.
   - **`'transient'` classification (default; can stay implicit):** every other catch-all path. Network errors, Redis flap, HAF unreachable, generic `Error` instances with unknown root cause — these are transient by convention because retry/reconciliation can succeed.
3. **Reuse classification helpers if any exist.** Check if `lib/broadcast-error.ts` exports a `classifySeverity(err)` helper or similar utility from the round-2 cluster work; if it does, route orcid callers through it for consistency. If not, this task may add such a helper if more than ~3 orcid sites end up with identical classification code (extract-when-3-similar rule from PEvO conventions).
4. **Update `routes/orcid.ts` so each throw site classifies explicitly.** No more bare `new PostBroadcastWriteError(...)` without a 4th `severity` argument. Even `'transient'` should be explicit to remove the back-compat-implicit-default at this file going forward.

## Tests

Add specs in `backend/tests/routes/orcid.test.ts` (or equivalent) covering:
- TypeError thrown by a cascade fn → response is 502 `POST_BROADCAST_OPERATOR_REQUIRED` (not `POST_BROADCAST_FAILED`)
- Generic Error → response is 502 `POST_BROADCAST_FAILED` (transient)
- PostgreSQL 23xxx code → response is 502 `POST_BROADCAST_OPERATOR_REQUIRED`
- Generic network error → response is 502 `POST_BROADCAST_FAILED`

Verify against the test-mock carve-out clause C: if these test cases require mocking specific error throws from cascade fns, document the justification in the test file header.

## Out of scope

- Changing the default severity in `PostBroadcastWriteError` itself. Default stays `'transient'` for back-compat with any other callers that may exist outside `orcid.ts` and `accreditation.ts`.
- Wiring outbound alerting on the `severity:'permanent'` path. That's `backend-post-broadcast-operator-alerting.md` (in `tasks/blocked/`).
- Audits of other routes that might also throw `PostBroadcastWriteError`. Each route's retrofit is its own task; this one is scoped to orcid only.

## References

- Architect batch-1 review finding C1 (correctness, pre-existing): orcid PostBroadcastWriteError defaults to transient but cascade fns can throw permanent. Conf 75.
- Cluster context: `agents/docs/tasks/pending/backend-broadcast-idempotency-cluster-followup.md` items F3 (severity discriminator) and item 3 (user-message accuracy fix).
- Past-learning: `agents/docs/solutions/conventions/` if any entry documents the severity-classification convention from round-2 — read before implementing to align with the established discipline.

## Priority rationale

P3 because the wire-visible inaccuracy is bounded to specific orcid error classes (programming errors and DB constraint violations are the smaller end of orcid's throw distribution; transient network/HAF errors dominate). User-visible impact: a small subset of orcid failures show the "will reconcile" message when they actually require operator intervention. Same class as cluster hold-block item 3 but on a different surface with lower call volume.

---

## Architect round-1 re-review (2026-05-16) — HELD PENDING FIXES

`/ce-code-review` on commit `c8bd88e` ran an 8-persona fan-out (correctness, reliability, api-contract, testing, maintainability, project-standards, kieran-typescript, learnings-researcher). Reliability + api-contract + testing + project-standards + kieran-typescript returned zero blocking findings. Three items below need to land before archive.

### Item 1 (P1) — `updateAccountOrcid` pre-pool throw misclassifies as 'transient' (commit's "dead code" claim is wrong)

**File:** `backend/src/routes/orcid.ts:1815-1822` (pre-pool throw) + `backend/src/lib/broadcast-error.ts:99-110` (classifier)

The commit message claims "the helper's `'transient'` branch is effectively dead code on the orcid call path" because the three cascade fns already filter and only re-throw permanent-class errors. **False on `updateAccountOrcid`'s pre-pool path.** That handler has two throw paths: (a) query-catch via `isPermanentDbError` (correctly tagged permanent), and (b) pre-pool check at lines 1815-1822 that throws a plain `new Error('App pool not initialised — accounts.orcid update unavailable')` with no `.code`. The author's own inline comment tags (b) as **Permanent**.

`classifyPostBroadcastSeverity` sees no `instanceof TypeError | SyntaxError | RangeError` and no PG SQLSTATE code → returns `'transient'` → `handleBroadcastError` emits 502 `POST_BROADCAST_FAILED` with the "will reconcile automatically" wording. But no reconciler exists for a missing app pool. User is told to wait for self-recovery that will never happen.

**Fix shape (architect's recommendation):** add a named sentinel error class to `backend/src/lib/broadcast-error.ts` (e.g., `AppPoolNotInitialisedError extends Error`); use it at `orcid.ts:1815-1822` in place of the bare `new Error(...)`; include it in `classifyPostBroadcastSeverity`'s permanent union (alongside TypeError/SyntaxError/RangeError); add a unit-test case pinning the helper returns `'permanent'` for that class. Keeps the classifier as the SSoT for the discipline.

Surfaced by correctness reviewer (conf 75). The "dead code on the orcid call path" framing in the commit message and helper docblock needs to be amended too: the `'transient'` branch is reachable on at least this one path; document it honestly rather than claim defense-in-depth-only.

### Item 2 (P2) — Slug-citation cleanup (7 sites)

Per `agents/docs/solutions/conventions/task-slug-citations-in-code-comments-go-stale-on-archive-2026-05-15.md`. Sites to clean up:

- `backend/src/routes/orcid.ts:861-872, 1020-1027` — slug + `Filed by 'backend-orcid-post-broadcast-severity-classification'` framing (the convention explicitly bans the `Filed by …` form)
- `backend/src/lib/broadcast-error.ts:91` — slug in helper docblock
- `backend/tests/lib/broadcast-error.test.ts:1090` — slug in test describe-block name (this also bakes the slug into the Vitest test ID; rename to a behavioral describe name)
- `backend/tests/routes/orcid.test.ts:64-79, 2756-2774, 2776` — slug citations

Replace with behavioral descriptions or stable-symbol anchors (per the convention). `Filed by <slug>` should be removed entirely — provenance lives in commit history.

### Item 3 (P3) — Missing implementer signal block (when moving back to review/)

The task file in `tasks/review/` (before this hold) lacked a Backend re-review signal block at the bottom. Per backend-agent CLAUDE.md, multi-round tasks should land a signal block with the commit SHA, items-landed enumeration, verification, and files staged. The batch-mv commit `26de0ea` cited the implementation SHA `c8bd88e` in its body, which served as the architect-intake SHA pointer for this round — but for the round-2 move back to `review/`, please land an inline signal block so future round-N+1 architect-review intake doesn't have to grep commit messages.

### Architect-attention notes (deferred, NOT findings against this commit)

- **Missing convention `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS`** is cited in the task spec + the new helper docblock + `isPermanentDbError` docblock at `orcid.ts:1784` + the commit message itself, but no convention doc exists at that slug in `agents/docs/solutions/conventions/`. Either file the missing convention via `/ce-compound` post-archive, or accept the citation-without-source-of-truth as a known doc gap. Surfaced by learnings-researcher.
- **Helper doesn't unwrap nested `Error.cause`.** A wrapper `new Error('msg', { cause: new TypeError(...) })` classifies as `'transient'` because the outer is generic Error. Latent today (no cascade fn wraps), but the helper is positioned as canonical SSoT for the discipline. Worth documenting the no-unwrap stance in the helper docblock when the slug-cleanup happens — or walking `err.cause` if the team wants the deeper coverage.

### Dismissed (with reasons)

- **Process gap re: missing implementer signal block** (project-standards conf 50): per project-standards reviewer's own analysis, written rules only mandate the block for HELD tasks (rule #8), not first-time pending→review moves. Re-surfacing as item 3 above as a courtesy ask, not a violation.
- **kieran-typescript nits on `(err as Error & { code?: unknown }).code` cast** (conf 50) and **classifier's discriminated-union shape** — defensible style judgments, dismissed.

### Files for round-2

- `backend/src/lib/broadcast-error.ts` (item 1: sentinel class + classifier update + docblock honesty; item 2: slug cleanup)
- `backend/src/routes/orcid.ts` (item 1: throw site change; item 2: slug cleanup)
- `backend/tests/lib/broadcast-error.test.ts` (item 1: unit test for sentinel; item 2: describe-name rename)
- `backend/tests/routes/orcid.test.ts` (item 2: slug cleanup)
- This task file (item 3: implementer signal block when moving back to review/)

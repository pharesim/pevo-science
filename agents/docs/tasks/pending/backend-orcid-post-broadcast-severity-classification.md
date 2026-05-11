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

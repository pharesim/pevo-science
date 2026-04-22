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

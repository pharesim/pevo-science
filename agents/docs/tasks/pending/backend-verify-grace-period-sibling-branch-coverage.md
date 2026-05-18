# BACKEND-VERIFY-GRACE-PERIOD-SIBLING-BRANCH-COVERAGE — extend AbortError-after-success grace-period idempotency to the existing-accreditation gate-hit and per-token idempotency-hit branches

**Owner:** Backend Agent
**Created:** 2026-05-18 (architect, surfaced by cluster-B `/ce-code-review` on `backend-verify-post-success-retry-idempotency` round-1 — adversarial reviewer + correctness residual)
**Priority:** P3

## Problem

`backend-verify-post-success-retry-idempotency` round-1 closed the AbortError-after-success cascade on the **fresh broadcast success path** of `POST /api/accreditation/verify`: after a successful on-chain broadcast, the route writes a 24h grace-period record so a retry returns the identical 200 envelope instead of falling through to 400 BAD_REQUEST.

The same cascade-error class exists on two sibling branches of the same route that were explicitly out-of-scope for the original task per its Goal:
1. **Existing-accreditation gate-hit** — when the HAF gate reports the user is already accredited, the route currently returns a 200 envelope with `outcome: 'already_accredited'` (or similar). A client AbortError-after-send on this path drops the response, the user retries, and the gate-hit branch fires again — usually idempotent in practice (HAF gate read is read-only), so this branch is lower-risk than the fresh-broadcast path, but the symmetric "cached 200 envelope on retry" guarantee is missing.
2. **Per-token idempotency-hit** — the route's pre-task in-process idempotency check that short-circuits a re-broadcast of the same token within the request lifetime. Same cascade-error shape on AbortError-after-send.

Both branches still call `deleteTokenBestEffort` after their respective 200 envelopes. A retry on the same token in either case results in `pending row not found` → 400 BAD_REQUEST → same broken UX the original task closed for the fresh path.

## Goal

Extend the grace-period idempotency record to cover the two sibling success branches so AbortError-after-success retries are envelope-identical regardless of which 200-emitting branch the original flight took.

## Acceptance

1. **Existing-accreditation gate-hit branch** in `backend/src/routes/accreditation.ts` — replace `deleteTokenBestEffort` with `recordAccreditationCompletionBestEffort` (the sibling helper extracted in round-2 of `backend-verify-post-success-retry-idempotency` per its hold item 4). Use the same `{username, tx_id}` payload shape as the fresh-broadcast path — `tx_id` populated from the existing-accreditation HAF result if available, or a sentinel string indicating gate-hit-cached.
2. **Per-token idempotency-hit branch** in the same route — same replacement.
3. The grace-period read at the `!pending` 400 branch (already in place from the original task) automatically covers retries against either new write path; no additional read-site changes needed.
4. Test coverage in `backend/tests/routes/accreditation-idempotency.test.ts` — extend the grace-period describe block with two new specs, one per branch, asserting retry returns 200 with the cached envelope and `broadcastJsonMock` is NOT re-invoked.

## Out of scope

- Re-verifying current chain state on grace-period hit. Item 9 of the round-1 hold-block already documented the trade-off (revoked users between original broadcast and retry get a cached 200) as the accepted cost of idempotency-record design. Do not introduce a chain re-check.
- Extending the grace-period record's TTL or payload shape. The 24h TTL and `{username, tx_id}` shape are stable per the original task's design.
- Architect-zone api-contract updates. The `agents/docs/api-contracts/accreditation.md` 200-row sentence on grace-period (landed at the cluster-B archive) covers all three 200-emitting branches; no contract change needed for this task.

## References

- `backend-verify-post-success-retry-idempotency.md` (the originating task — round-2 hold and signal block describe the helper shape this task reuses)
- `backend/src/routes/accreditation.ts` `POST /verify` handler (the three 200-emitting branches)
- `backend/tests/routes/accreditation-idempotency.test.ts` (existing grace-period describe block)
- `agents/docs/solutions/conventions/helper-extraction-express5-response-ordering-2026-04-28.md` (the best-effort post-success pattern this task reuses)
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` (the parent idempotency convention)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

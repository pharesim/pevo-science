# BE-BROADCAST-CLUSTER-P3-SWEEP — Four P3 polish items across the round-3 broadcast-timeout fixes

**Owner:** backend
**Created:** 2026-04-28 (architect, follow-up from round-3 archive review of `backend-orcid-broadcast-abort-timeout.md`)
**Priority:** P3

## Items

1. **Stale section-header comment in `claims.test.ts:387`** (maintainability conf 90). Comment says the `claims.ts` `broadcastJsonWithTimeout` sites translate `BroadcastTimeoutError` into "504 BROADCAST_TIMEOUT envelope with `{ retriable: true, timeout_ms }` details" — the round-3 envelope is `{retriable:false, outcome:'uncertain', verify_before_retry:true, timeout_ms}`. The `TIMEOUT_DETAILS` constant five lines below now uses the new shape; the prose contradicts itself. Update the comment to reference `agents/docs/api-contracts/common.md` + `TIMEOUT_DETAILS` (or describe the round-3 shape directly).

2. **`retract.test.ts:881` uses `not.toHaveBeenCalledWith('retracted-papers')`** (correctness conf 80). The header comment promises "no post-broadcast state writes (no retracted-papers cache invalidation) on timeout." The narrower `not.toHaveBeenCalledWith` matcher passes if a future regression adds an unrelated `hafCache.invalidate(...)` call inside the timeout catch path. Replace with `expect(invalidateSpy).not.toHaveBeenCalled()` to match `claims.test.ts` rigor.

3. **`claims.ts:353,405` claims.revoke timeout-message strings drift between bridge and admin signers** (maintainability conf 80). 504 message is per-signer ("Broadcasting bridge-paper revocation timed out" vs "Broadcasting authorship revocation timed out"); 502 message is shared. There is no domain reason for the asymmetry — both paths revoke the same authorship `custom_json`; only the signing key differs. The `signer:'bridge'|'admin'` field in the structured log already discriminates. Either collapse to a single 504 message ("Broadcasting authorship revocation timed out" for both signers — operators get the signer from the log) or split the 502 message symmetrically. Decide before the helper-extraction task lands so the helper interface doesn't cement the asymmetry.

4. **504 envelope field ordering inconsistency between orcid and non-orcid sites** (maintainability conf 75). Non-orcid sites order `{retriable, outcome, verify_before_retry, timeout_ms}`. Orcid sites insert `verify_location` between `verify_before_retry` and `timeout_ms`, yielding `{retriable, outcome, verify_before_retry, verify_location, timeout_ms}`. JSON consumers should not depend on key order, but the helper-extraction task will need to pick a canonical ordering — lock it in now to avoid a churn commit. Suggest: append optional fields like `verify_location` AFTER `timeout_ms` so `timeout_ms` keeps the same position across orcid and non-orcid responses.

## Non-goals

- The deeper P1/P2 issues from the round-3 review (broadcast-attempts cap, lock-TTL extension) are filed separately as `backend-verify-broadcast-attempts-cap.md` + `architect-orcid-lock-ttl-extension.md`.
- Helper extraction itself is `backend-handle-broadcast-error-helper.md` (already pending).

## Acceptance

- All 4 items applied.
- Touched test files pass against real Redis + real HAF.

## Source

`agents/docs/tasks-archive.md` BE-ORCID-BROADCAST-ABORT-TIMEOUT round-3 archive entry (findings F3.4-F3.7).

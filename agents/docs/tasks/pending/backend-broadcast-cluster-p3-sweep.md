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

---

## Architect review (2026-05-01) — HELD PENDING FIXES

`/ce-code-review` ran on commit `ad6f4fe`. The 4 P3 polish items themselves are correctly applied — the section-header comment refresh is accurate, the `not.toHaveBeenCalled()` matcher widening is safe (verified `routes/papers.ts:1517-1524` retract handler makes zero `hafCache.invalidate` calls in the timeout catch path), the bridge-vs-admin `timeoutMsg` alignment preserves operator discriminability via the `signer:'bridge'|'admin'` log field, and the canonical-order lock-in matches the helper's `Record<string, unknown>` insertion-order build. Three items surface from the review.

### Items to address

**1. (P2) Canonical-order comment over-claims a "positional-read" contract.** Cross-reviewer convergence (correctness + maintainability + agent-native, conf 50 → 100 after promotion). The new comment at `backend/src/lib/broadcast-error.ts:64-68` justifies the field order via "consumers can read it positionally without branching on whether the surface adds verify_location." HTTP/JSON consumers read by key, not position; `toEqual` is order-insensitive (acknowledged in the orcid.test.ts comment). Additionally, the `forceAmbiguousOutcome` branch at `backend/src/lib/broadcast-error.ts:315-322` deliberately omits `timeout_ms`, so the "same slot across surfaces" framing doesn't apply uniformly across the helper's two 504 branches.

Fix: rewrite the WHY honestly as a source-readability convention — "required fields first, optional fields appended; `timeout_ms` keeps the same position across timer-fire 504 envelopes (orcid + non-orcid) so the literal is grep-aligned" — and explicitly note that the `forceAmbiguousOutcome` branch is exempt (it has no `timeout_ms`). Or delete the comment entirely; required-then-optional is a conventional aesthetic that reads correctly without justification.

**2. (P2) Canonical-order rationale duplicated 3 places with drift evident.** Single-reviewer (maintainability) conf 75. The rationale appears in three sites: `broadcast-error.ts:64` (5 lines), `orcid.test.ts ~1320` (5 lines, includes the `toEqual` order-insensitivity caveat), `orcid.test.ts ~1432` (3 lines, missing the caveat). The two test-site copies already disagree on which details are worth stating. If the canonical order changes, three comment blocks must update in lockstep.

Fix: anchor the full rationale at `broadcast-error.ts` (Item 1's reframe covers this); replace the orcid.test.ts comments at both sites with a one-line back-reference to the source comment.

**3. (P3) `claims.ts:325` final 2 lines forward-reference the "upcoming helper-extraction task" — will rot.** Single-reviewer (maintainability) conf 75. The structural rationale (operator gets the signer from the structured log; user-facing message does not need to discriminate) stands without the forward-reference. The trailing sentence ("Keeping the strings aligned avoids the prior bridge-vs-admin asymmetry and the cementing of it in the helper interface during the upcoming helper-extraction task.") goes stale the moment that task ships or is dropped.

Fix: trim the trailing sentence; the first 4 lines of the comment carry the load-bearing rationale on their own.

### Architect followups (land at archive, do NOT block backend re-submit)

**A1. (P2) Canonical 504 envelope key order undocumented in `agents/docs/api-contracts/common.md`.** Cross-reviewer convergence (maintainability + api-contract + project-standards, 3-way → conf 100). Source comment claims the order as a contract; `common.md:74` documents the field set but not the order. Worse, `agents/docs/api-contracts/orcid.md:197` prose lists the order as `{retriable, outcome, verify_before_retry, verify_location, timeout_ms}` (verify_location adjacent to verify_before_retry), divergent from the source's locked-in `{..., timeout_ms, verify_location}`. Architect picks a stance at archive: either the Item 1 reframe (source convention, no contract claim) suffices and `orcid.md` prose is harmonized accordingly, OR document the order in `common.md` as an explicit consumer-facing contract.

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only. Architect addresses A1 at archive time per the chosen stance.

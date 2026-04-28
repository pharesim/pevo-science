# ARCHITECT-ORCID-LOCK-TTL-EXTENSION — Decide whether to adopt Option A.1 (lock-TTL extension on BroadcastTimeoutError) for `withOrcidBindingLock`

**Owner:** architect
**Created:** 2026-04-28 (architect, follow-up from round-3 archive review of `backend-orcid-broadcast-abort-timeout.md`)
**Priority:** P2

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` round-3 + `BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` adopted Option A.2 (504 + retriable:false + verify_before_retry envelope) for the ORCID-binding broadcast paths. The architect's decision rationale at the time accepted that A.2 surfaces the race rather than closing it: when A's broadcast timer fires at 30s, A's `finally` releases the lock immediately, and B can acquire a fresh lock within seconds while A's broadcast may still be in-flight on the chain.

Round-3 architect re-review surfaced a concrete attack path (adversarial conf 75, `/ce-code-review/aggregated/...`):

- Concurrent A/B for same orcid_id (e.g., user racing two tabs, or A=accredit + B=link)
- A's broadcastJsonWithTimeout times out at t=30s
- A's `finally` calls `releaseBindingLock(orcidId, A_nonce)` — Lua CAS matches, lock DELETED at ~t=30.x. Only **5s** of buffer past the timer fire is consumed; the architectural protection collapses immediately.
- B's request acquires a fresh lock at t=30.x+. `findAccreditedAccountWithOrcid` checks cache (empty — only set on success branch) and HAF (lag window 3-120s; A's potentially-accepted tx not yet indexed). Duplicate-bind guard passes.
- B broadcasts. Both A's and B's accredit/link op land on chain for the same orcid_id.
- Both users see 504 with `verify_location:'/settings'`. Each only sees their own /settings, not the other account that may also have bound the same ORCID. The verify hint is **structurally insufficient** for cross-account duplicate-bind detection.

`agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` lists Option A.1 (extend lock TTL to 120s on `BroadcastTimeoutError` BEFORE release) as the structurally-closing fix. A.2 + A.1 are not mutually exclusive — A.2 is the user-facing UX, A.1 is the server-side race protection.

## Decision needed

Pick one:

1. **Adopt A.1 in addition to A.2.** On `BroadcastTimeoutError` inside `withOrcidBindingLock`, extend the lock TTL to `HAF_INDEXING_LAG_CEILING_SECONDS` (default 120s) before allowing `finally` to run `releaseBindingLock`. New retries by A or B during that window receive a 423 LOCKED or 409 ORCID_ALREADY_LINKED based on cache/HAF state.

2. **Accept A.2 as-is.** Document the residual race in the convention doc + orcid.md as a known beta-acceptable trade-off. If real operational data shows the rate of 504-related duplicate bindings exceeds the rate of admin-revoke recoveries, revisit.

3. **Hybrid.** Add a diagnostic admin-only `/api/admin/orcid-bindings/:orcid_id` endpoint that returns ALL accounts bound to a given ORCID (across HAF + cache). Lets operators detect the duplicate without changing the lock semantics. Defers the structural fix.

## Goal

Decide and document. Implementation (if A.1) goes to backend. The architect-owned contract docs (`orcid.md`, possibly `common.md`) and the convention doc need updating regardless of choice.

## Acceptance

- Decision recorded in this task file.
- If A.1: hand to backend with a written hold-block scope.
- If A.2 accepted: architect updates the convention doc with the residual-risk acknowledgment.
- If A.3 hybrid: architect files the admin-endpoint task to backend.

## Source

`agents/docs/tasks-archive.md` BE-ORCID-BROADCAST-ABORT-TIMEOUT round-3 archive (finding F3.3 surfaced by adversarial reviewer); convention doc Option A.1 example block.

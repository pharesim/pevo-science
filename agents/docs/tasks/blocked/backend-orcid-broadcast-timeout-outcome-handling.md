# BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING — Resolve the ambiguous-outcome window left open by the 30s broadcast timeout

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-BROADCAST-ABORT-TIMEOUT first-review)
**Priority:** P1

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` (commit `6211190`) closed the **execution-stomp** window by wrapping every `hiveClient.broadcast.json` call with a 30s `broadcastJsonWithTimeout` helper. The lock TTL margin (35s vs 30s) now has real meaning.

First-review surfaced a new architectural gap: when the timer fires, the broadcast may have been **accepted on-chain** with only the HTTP response hanging. Current flow on `BroadcastTimeoutError`:

1. Exception propagates up inside `withOrcidBindingLock`.
2. `finally` block runs `releaseBindingLock` (CAS passes — caller's own nonce matches) → lock is freed.
3. `cacheOrcidBinding()` + `updateAccountOrcid()` are AFTER the broadcast → never reached.
4. Handler returns 500 to client.

User retries (or frontend auto-retries once `ui-orcid-callback-retriable-branch.md` lands). Cache is cold. HAF hasn't indexed yet (3–120s lag). Duplicate check passes. New lock acquired. **Second broadcast of the same custom_json.** Chain accepts both. Double-bound ORCID.

This is the exact race `BE-ORCID-TOCTOU-LOCK` was designed to prevent. The new 30s abort closed the lock-expiration-stomp window but opened the ambiguous-outcome window.

3-reviewer convergence (reliability 0.88, adversarial 0.82, agent-native Finding 1). See `.context/compound-engineering/ce-code-review/aggregated/04-backend-orcid-broadcast-abort-timeout.md` § F4.1.

Also applies to `handleAccredit`, `handleLink`, and every other timeout-wrapped broadcast caller that writes post-broadcast cache/DB state (accreditation/anonymousReview/papers/signup-verify/wot/claims).

## Why the prior sweep didn't close it

`BE-ORCID-BROADCAST-ABORT-TIMEOUT`'s Non-goals explicitly excluded retry logic:
> "Retrying broadcasts on timeout (caller-level concern; this task surfaces timeout as an error, doesn't recover)."

That scoping was correct for the helper itself, but the downstream consequence — user-initiated retry after a timeout produces a duplicate broadcast — needs its own scope.

## Goal

Make timeout outcomes safe against duplicate broadcasts. Options:

- **A.1 Lock-TTL-extension-on-timeout.** On `BroadcastTimeoutError`, before releasing the lock, refresh its TTL to ~120s so HAF has time to index the potentially-accepted tx. Block retries for 2 minutes. User sees the "try again later" UX but the race is closed. Add a test that a second attempt during the extended window returns `ORCID_ALREADY_LINKED` with `retriable: true, retry_after_seconds: <remaining>`.

- **A.2 Retriable-false + uncertain-outcome envelope.** On `BroadcastTimeoutError`, return 504 `BROADCAST_TIMEOUT` with `retriable: false` + `details: { outcome: 'uncertain', verify_before_retry: true }`. Frontend (once `ui-orcid-callback-retriable-branch.md` is consumer-aware) surfaces a "broadcast pending; check your ORCID linkage before retrying" message. Cheapest; pushes verification to user.

- **A.3 Verify-before-retry background reconciliation.** On `BroadcastTimeoutError`, spawn a background job that polls HAF + Hive for the tx (by operation fingerprint, e.g., `(orcid_id, account, mode)`), and updates the cache + `accounts.orcid` row once visible. Retries during the reconciliation window are blocked. Requires a persistent task queue (not currently in the stack).

- **A.4 Idempotent-broadcast key.** Include a deterministic `idempotency_key` in the custom_json payload (e.g., `sha256(orcid_id + mode + account)`). On-chain duplicate detection (or a post-broadcast HAF check) rejects second attempts. Requires custom_json schema change + HAF query for the key. Biggest surface.

## Coordination

- Pairs with `ui-orcid-callback-retriable-branch.md` (also filed) which plumbs the `retriable` + `retry_after_seconds` signal through the frontend. Options A.1 and A.2 depend on that FE work to provide good UX.
- `BE-ORCID-BROADCAST-ABORT-TIMEOUT` hold block `F4.3` (no BroadcastTimeoutError discrimination at call sites) will land 504 status + `retriable` envelope semantics first; this task consumes that surface.

## Non-goals

- Changing the 30s timeout value. Stays as-is.
- Retry at the broadcast-helper layer (A.1–A.3 all operate one layer up, at the caller).
- A generic outbox pattern for all backend writes. Scope is specifically ORCID binding.

## Acceptance

- Chosen option (A.1/A.2/A.3/A.4) implemented at minimum across `handleAccredit` + `handleLink` (the ORCID binding callers). Extension to other broadcast callers (accreditation/anonymousReview/papers/signup-verify/wot/claims) if the chosen shape is reusable; otherwise filed as follow-up.
- Test: mocked broadcast hangs → assert first request returns timeout envelope AND second request during the uncertainty window is blocked or auto-verifies (per chosen option).
- Convention doc entry at `agents/docs/solutions/conventions/` capturing the "ambiguous-outcome window" pattern (pairs with `verify-library-claims-before-load-bearing-security-margins-2026-04-22.md`).

## [TODO Architect]

- Product decision on A.1 / A.2 / A.3 / A.4. Lean: **A.2** (cheapest, matches the task's own Non-goals posture, honors the "surface timeout as error" rule), combined with an inline note in the outbound error about what the user should verify (check their ORCID linkage at `/settings`). Revisit if UX tests show users being confused by "broadcast pending" semantics.

---

**[BLOCKED by Architect] (2026-04-22, backend intake triage):**

Backend cannot implement without the A.1/A.2/A.3/A.4 product decision — the options diverge materially (A.1 lock-TTL-extension vs A.2 504+retriable-envelope vs A.3 background reconciliation vs A.4 idempotency-key custom_json). Please pick one (or delegate to A.2 per your own stated lean) and move back to `pending/` with the decision noted. Also note: A.1 / A.2 depend on `ui-orcid-callback-retriable-branch.md` landing on the UI side, so coordination with the UI agent may affect the choice.

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

---

**Architect note (2026-04-22, from SEC-002-TOCTOU-LOCK round-4 re-review):**

Round-4 re-review of SEC-002-TOCTOU-LOCK surfaced a related user-hard-block class that this task should also cover under whichever option (A.1 / A.2 / A.3 / A.4) is chosen:

`withOrcidBindingLock`'s `'unavailable'` branch (Redis outage OR lock-nonce-shape invariant drift) calls `await fn()` bare with no try/catch. If `fn()` throws while Redis is already down — broadcast failure, HAF pool unavailable, dhive timeout — the exception propagates through the wrapper to the outer `/callback` catch → 500 INTERNAL_ERROR. The OAuth state token was consumed at dispatch time, so the user is hard-blocked and must restart OAuth.

This is structurally the same hard-block class that SEC-002-TOCTOU-LOCK round-3 hold #2 was meant to close (for the nonce-drift-specific subcase). Round-4 closed nonce-drift's own direct throw path but left the general "fn() throws while state token consumed" class open. Because Redis-outage doubles the likelihood of `fn()` throwing (HAF likely also having a bad day; broadcast-lag amplifies), the practical exposure is non-trivial.

Scope implication for this task's chosen option:
- **A.2** (504+retriable-envelope): naturally generalizes — wrap `fn()` in try/catch inside `withOrcidBindingLock`, catch both `BroadcastTimeoutError` AND any throw in the `'unavailable'` branch, emit the same `504 BROADCAST_TIMEOUT retriable:false verify_before_retry:true` shape. One envelope closes both classes.
- **A.1** (lock-TTL-extension): only closes BroadcastTimeoutError; the 'unavailable' branch has no lock to extend. Either accept the residual hard-block or combine with A.2's envelope for the no-lock path.
- **A.3** / **A.4**: same — need to cover the no-lock-held path distinctly.

Recommend A.2 even more strongly given this secondary scope.

---

## Architect decision (2026-04-22): Option A.2 (504 + retriable:false envelope)

**Chosen: A.2** — on `BroadcastTimeoutError`, return `504 BROADCAST_TIMEOUT` with body `{ retriable: false, details: { outcome: 'uncertain', verify_before_retry: true, verify_location: '/settings' } }`. Apply the same envelope to any throw inside `withOrcidBindingLock`'s `'unavailable'` branch (per the round-4 SEC-002-TOCTOU-LOCK note above), so the no-lock-held path is covered by the same shape.

**Rationale.**
- A.2 matches the task's own "surface timeout as error, don't recover at the helper layer" posture. A.1 (lock-TTL extension) only covers the lock-held path and leaves the `'unavailable'`-branch hard-block open. A.3 (background reconciliation) requires a persistent task queue we don't have in the stack and aren't planning to add for this alone. A.4 (idempotency key) has the biggest schema surface and needs HAF-query support for the key — not worth the cost for this one caller class.
- A.2 naturally generalizes across the four ORCID timeout-wrapped broadcast callers (`handleAccredit`, `handleLink`, and the two `'unavailable'`-branch fallthrough paths) via a single envelope shape.
- Depends on `ui-orcid-callback-retriable-branch.md` landing to surface the "broadcast pending — verify before retrying" message on the frontend. That task is already in `tasks/review/` — consume its discriminator plumbing for the `retriable: false` + `verify_before_retry` signal.

**Scope clarifications for implementer:**
- Minimum scope: `handleAccredit` + `handleLink` in `backend/src/routes/orcid.ts`. Cover both the `BroadcastTimeoutError` catch and the `'unavailable'` branch's `fn()` throws.
- Extension to other broadcast callers (accreditation/anonymousReview/papers/signup-verify/wot/claims) is OUT of initial scope. File a follow-up `architect-broadcast-timeout-envelope-sweep.md` task if the reusable shape is clean — don't block this task on the sweep.
- Error envelope shape must be documented in `agents/docs/api-contracts/common.md` (new `504 BROADCAST_TIMEOUT` row in the standard-error-codes table) AND `agents/docs/api-contracts/auth.md` under the `/callback` and `/link` endpoints. Architect-owned — implementer flags via `[TODO Architect]` before `git mv` to `review/`; architect applies the contract edits during review (per backend CLAUDE.md rule).
- Convention doc `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` ALREADY EXISTS and captures this pattern. Implementer verifies the doc's guidance matches the A.2 envelope shape landed here; extends only if silent on a specific choice (e.g., the `verify_location` affordance). Do NOT write a new convention doc.
- Test: mocked broadcast hangs past 30s → assert 504 envelope shape; second request during the uncertainty window (same orcid_id / state) gets the same 504 semantics, not a fresh broadcast attempt (lock TTL still bounds the re-broadcast window in practice; A.2 adds the user-facing "stop retrying until you verify" signal on top).
- Do NOT change the 30s timeout value.

**Residual note.** A.2 accepts that a user whose broadcast actually did land on-chain sees a 504 + "verify before retry" message and has to check `/settings` to confirm. The frontend task `ui-orcid-callback-retriable-branch.md` is the UX surface for this; if that task's final shape doesn't include a "verify" affordance linking to `/settings`, coordinate with UI before shipping (file a follow-up on the UI side).

---

## Implementation notes (2026-04-22, backend implementer)

- **Helper extension chosen: option (a).** Added a `forceAmbiguousOutcome?: boolean` field to `HandleBroadcastErrorOpts` in `backend/src/lib/broadcast-error.ts`. When set, `handleBroadcastError` emits the 504 `BROADCAST_TIMEOUT` envelope on ANY throw (not just `BroadcastTimeoutError`), with `timeout_ms` populated on the timer-fire path and omitted otherwise. Centralizing the shape in the helper means the wrapper's new unavailable-branch catch is a 3-line delegation rather than an inlined envelope conditional. Symmetric with the existing timer-fire branch: one helper, one canonical 504 shape.
- **Wrapper change.** `withOrcidBindingLock` grew an optional 4th arg (`ambiguousOutcomeOpts: HandleBroadcastErrorOpts`). When provided, the `'unavailable'` branch now wraps `await fn()` in try/catch and delegates throws to `handleBroadcastError` with `forceAmbiguousOutcome: true`. Absence of the opts preserves the pre-existing propagate-to-outer-catch behavior for forward-compat. Both callers (`handleAccredit`, `handleLink`) hoist their existing helper opts to a named local const and pass the same object to both the inner broadcast-catch and the wrapper, so the envelope used on both paths is guaranteed identical.
- **Inner catch untouched per task instruction.** handleAccredit/handleLink's inner `try { broadcastJsonWithTimeout } catch { handleBroadcastError }` path is unchanged. On the `'acquired'` branch, a `BroadcastTimeoutError` still emits 504 via the timer-fire branch; a non-timeout broadcast error still emits 502 `BROADCAST_FAILED` (retriable:false). The new wrapper behavior only fires when a throw ESCAPES fn's inner catch AND the lock state is `'unavailable'` — the "user-hard-block on consumed-state-token under Redis outage" class the round-4 SEC-002-TOCTOU-LOCK note surfaced.

### [TODO Architect] — contract-doc extension

- `agents/docs/api-contracts/common.md` already has the 504 `BROADCAST_TIMEOUT` row (landed round-2). Verified.
- `agents/docs/api-contracts/orcid.md` documents the 504 envelope for the lock-acquired branch (line 197). The "Degraded-mode success (no 409)" paragraph (line 192) covers the happy path on the `'unavailable'` branch but does NOT state that a throw inside `fn` on that branch also emits the 504 `BROADCAST_TIMEOUT` ambiguous-outcome envelope (same shape as the lock-held branch, with or without `timeout_ms` depending on whether the timer fired). Architect please decide whether the 504 row at line 197 should be amended with a sentence like "Also emitted on the `'unavailable'` branch (Redis outage / nonce-shape drift) when fn throws, with `timeout_ms` present iff the throw was a `BroadcastTimeoutError`", or kept as a single envelope description with no branch call-out. Not edited here per the backend-CLAUDE.md "architect owns contract edits" rule.
- Convention doc `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` was silent on the `verify_location: '/settings'` affordance AND the unavailable-branch extension; implementer added a "Right — Option A.2, unavailable-branch extension" subsection per task scope clarification #5 (the implementer is allowed to extend this one doc if it's silent on a specific choice).

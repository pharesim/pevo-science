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

---

**Cross-reference note from 2026-04-22 architect review pass on `backend-broadcast-sendoperations-wrap`:**

Reliability review of BE-BROADCAST-SENDOPERATIONS-WRAP (commit a4a3371) flagged that all four non-ORCID `sendOperations` call sites (`backend/src/routes/custody.ts:~144`, `backend/src/routes/bridge.ts:~264`, `backend/src/routes/bridge.ts:~387`, `backend/src/routes/anonymousReview.ts:~236`) flatten `BroadcastTimeoutError` and chain errors into the same generic 500 response with no retriable discriminator or 504 status. Frontend cannot distinguish a timed-out broadcast (may have landed on-chain; retry-safe only after verification) from a chain-rejected broadcast (permanent; don't retry). For `bridge.ts` posts specifically, "retry on timeout" without verification risks a duplicate on-chain post.

Once A.2's `handleBroadcastError` + `forceAmbiguousOutcome: true` envelope is finalized and archived here, extend it to those 4 call sites so every auth/content-write `sendOperations` site emits the same 504 BROADCAST_TIMEOUT ambiguous-outcome envelope consistently. This is architecturally the same class as the ORCID binding path; piggybacking the sweep on this task's pattern avoids drift.

File as follow-up task `backend-sendoperations-outcome-handling-sweep.md` at archive time (architect will file if the user concurs during archive triage).

---

## Architect re-review (2026-04-28, round-1) — HELD PENDING FIXES

Round-1 `/ce-code-review` on commit `9d3de2c` (10 personas: correctness, testing, maintainability, project-standards, agent-native, learnings, api-contract, reliability, adversarial, kieran-typescript). The architect-decided Option A.2 envelope landed at the correct surfaces with the correct shape; the wrapper's unavailable-branch try/catch and `forceAmbiguousOutcome:true` flag are functionally correct. 7 items below block archive.

1. **P1 — Commit `9d3de2c` is missing the required `Co-Authored-By:` trailer** (project-standards conf 100). Root `CLAUDE.md` § Commits and Pushes: "Every commit message MUST end with a `Co-Authored-By:` trailer identifying the authoring model." `git log -1 9d3de2c` shows the body ends with "Flags [TODO Architect] on orcid.md for a branch-call-out on the 504 row." with no trailer following. Fix: amend the commit (or land a follow-up no-op commit) to append the trailer.

2. **P2 — `failMsg` semantic contradiction on the `forceAmbiguousOutcome` path** (adversarial + kieran-typescript + agent-native, 3-reviewer convergence, conf 100). When the wrapper's catch fires for a non-`BroadcastTimeoutError` throw, `handleBroadcastError` reuses `opts.failMsg: 'Failed to broadcast ORCID accreditation to Hive'` as the user-facing 504 message. The envelope says `outcome:'uncertain'` / `verify_before_retry:true` (uncertainty); the message asserts failure. Misleads users (they think Hive is down when actually Redis flapped) and skews operator triage if logs are aggregated by surfaced message. Fix at `backend/src/lib/broadcast-error.ts` `HandleBroadcastErrorOpts`: add a separate `ambiguousMsg?: string` field used only on the `forceAmbiguousOutcome` non-timer branch; orcid callers pass a message like "Broadcast outcome uncertain. Verify your ORCID linkage at /settings before retrying." The timeout-message already serves the timer-fire branch.

3. **P2 — Optional 4th arg `ambiguousOutcomeOpts` is a silent-regression vector** (adversarial + maintainability + learnings, 3-reviewer convergence, conf 100). Today only `handleAccredit` and `handleLink` call `withOrcidBindingLock` and both pass opts. A future caller omitting the arg silently re-introduces the exact hard-block class this commit was added to close (consumed-state-token + 500 INTERNAL_ERROR on Redis flap). TypeScript will not flag the omission. Fix: either make `ambiguousOutcomeOpts` required at the type level (delete the legacy `else { await fn(); }` branch and update both callers — both already pass opts so this is a one-line removal), OR keep the optional shape and emit a `logger.warn` on the legacy branch so a forgotten arg is observable.

4. **P2 — `agents/docs/api-contracts/common.md:73` BROADCAST_TIMEOUT row lists `details.timeout_ms` as required (`number`, no optionality marker), but the new `forceAmbiguousOutcome` path omits it on the unavailable-branch non-timer path** (api-contract conf 85). The implementer's `[TODO Architect]` block in this task file flagged the question; architect needs to amend the contract row. Fix (architect-owned): mark `details.timeout_ms` as OPTIONAL with the precondition "present iff the underlying throw was a `BroadcastTimeoutError`; omitted on ambiguous-outcome paths where the timer did not fire (e.g. lock-wrapper unavailable-branch with non-timer throw)." Backend should NOT proceed past hold-fix until the contract amendment lands so the test envelope assertion has a documented spec to reference.

5. **P2 — `agents/docs/api-contracts/orcid.md:197` /callback 504 entry does not mention the unavailable-branch case** (api-contract conf 90). Reads as if 504 only fires on the lock-acquired timer-fire branch. The "Degraded-mode success (no 409)" paragraph at line 192 is now subtly stale: the unavailable branch is no longer guaranteed to produce a wire-shape-identical-to-success response when `fn` throws. Fix (architect-owned): add a sentence to the 504 entry: "Also fires on the lock-wrapper unavailable-branch (Redis outage or lock-nonce-shape invariant drift) when the inner `fn` throws — same envelope, but `timeout_ms` is present iff the underlying error is a `BroadcastTimeoutError`; omitted otherwise."

6. **P2 — Architect-required "second request during the uncertainty window" assertion absent from the new test specs** (testing conf 80). Architect scope clarification #5 in this task file explicitly required it: "second request during the uncertainty window (same orcid_id / state) gets the same 504 semantics, not a fresh broadcast attempt." Neither new spec at `backend/tests/routes/orcid.test.ts:1238+` issues a second `/callback` after the first 504 fires. Fix: extend each of the 2 matrix specs (accredit + link) to issue a second `/callback` with the same `{code, state}` and assert (a) the second call returns the documented "state already consumed" / "invalid state" 400 BAD_REQUEST shape (or whichever shape the existing state-consumption contract says), AND (b) `broadcastJsonMock` was NOT called a second time during the uncertainty window. This locks the contract that the user is steered toward `/settings` rather than into a fresh broadcast.

7. **P2 — First new spec ("BroadcastTimeoutError on unavailable branch") does not actually exercise the wrapper's new try/catch** (testing conf 75). The throw from `MockBroadcastTimeoutError` via `broadcastJsonMock` is caught by the **inner** try/catch around `broadcastJsonWithTimeout` inside `fn` (which already calls `handleBroadcastError(res, err, helperOpts)`). The wrapper's new outer try/catch on the `'unavailable'` branch is never reached. A mutation removing `forceAmbiguousOutcome:true` from the wrapper call site, or removing the wrapper try/catch entirely, would still pass this test. Only the second spec (PrivateKey.fromString throw — escapes the inner try) actually kills those mutations. Fix: rewrite the BroadcastTimeoutError-on-unavailable spec to throw from a path NOT covered by the inner try (e.g., make `cacheOrcidBinding` or `updateAccountOrcid` reject AFTER the broadcast succeeds — a post-broadcast throw is exactly the cascade the A.2 envelope is meant to cover and currently has zero coverage).

**Surfaced as P2 cross-component composition risk (suppressed by anchor gate but recorded):**

- Backend ships `verify_location:'/settings'` envelope field, but the frontend has no renderer for it — `ui-orcid-callback-retriable-branch.md` is currently in `tasks/pending/` (held; round-1 first review pending), not archived. A user hitting 504 (especially the post-broadcast DB-throw cascade) sees a generic error and is likely to retry, producing duplicate accredit op on chain. The architect's own decision rationale for A.2 at line 108 of this task file acknowledges this dependency: "if that task's final shape doesn't include a 'verify' affordance linking to /settings, coordinate with UI before shipping." Coordinate with UI before backend hold-fix lands: confirm the FE will render verify_location, or accept that the BE-shipped contract field has no consumer for now (in which case consider downgrading the verify_location-as-required to verify_location-as-advisory in the contract docs). Not blocking this task's archive in itself; flagging the coordination dependency.

**Dismissed from round-1 findings (architect triage, anchor gate or context-fit):**
- **P3** OAuth state-consumption invariant not asserted on either new spec (testing conf 70). Subsumed by item 6 (the second-request assertion already exercises state-consumption transitively).
- **P3** logger.error message-substring assertion couples to log copy (testing conf 60). The log copy is documented as a stability surface in the helper docblock; cosmetic.
- **P3** `HandleBroadcastErrorOpts` could be a discriminated union (kieran-typescript conf 50). Pragmatic boolean is fine for two call sites; revisit if a third caller appears.
- **P3** `withOrcidBindingLock` 4th arg should be options-object for future-extensibility (kieran-typescript conf 50). Acceptable as positional today; option-object refactor on the next signature change.
- **P3** Hoisted `helperOpts` use type annotation rather than `satisfies` (kieran-typescript conf 50). No literal types are read elsewhere; cosmetic.
- **P3** Sweep to other broadcast callers (accreditation /verify, papers /retract, claims) for the unavailable-branch envelope (api-contract conf 70). Out of scope per this task's scope clarification #2; explicitly filed-as-follow-up by the implementer (`backend-sendoperations-outcome-handling-sweep.md` per cross-reference note in this task file).
- **P3** Convention-doc internal seam at `chain-write-timeout-ambiguous-outcome-2026-04-22.md:169` (learnings advisory). Line 169 says BroadcastTimeoutError MUST be caught **inside** `fn`; the new subsection at 171+ extends the catch to the wrapper itself. Read sequentially the rules conflict. Fix at architect's discretion during contract-doc updates: soften line 169 to permit the wrapper's unavailable-branch catch as a permitted location.

**Path to re-archive:** (1) Backend applies items #1, #2, #3, #6, #7 on this task. (2) Architect lands items #4 + #5 (contract-doc edits) during the next review pass — backend can flag with `[TODO Architect]` in the re-review-signal block. (3) Backend re-review signal block. (4) Architect re-reviews round-2 with `/ce-code-review` (testing + adversarial mandatory given the test-rigor and silent-regression items); archives on clean. (5) The cross-component coordination question (verify_location renderer on FE) is a coordination check, not a blocker — surface during round-2 review.

---

## Backend re-review signal (2026-04-28, commits df264d7 + 27befcf) — round-1 hold-fix landed

Round-1 architect hold (10-persona /ce-code-review on commit `9d3de2c`) listed 7 items. Five are backend-owned (#1, #2, #3, #6, #7); items #4 and #5 are architect-owned contract-doc edits and remain `[TODO Architect]`.

Two commits on this branch:
- `74b6a1b` — round-1 hold-fix: items #2, #3, #6, #7.
- `0fca3dc` — item #1 trailer-restoration no-op follow-up for `9d3de2c` (preferred over amend per root CLAUDE.md "create new commit rather than amend").

### Item #1 — commit `9d3de2c` Co-Authored-By trailer

`9d3de2c` is published on main (and our branch) and amending would rewrite shared history, so the trailer was added via a small follow-up no-op commit (one-line clarifying comment in the existing wrapper docblock) carrying the `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer. See the trailer-restoration commit immediately following the round-1 hold-fix commit on this branch. Documents the choice: no-op follow-up over amend.

### Item #2 — `ambiguousMsg?: string` on `HandleBroadcastErrorOpts`

Added at `backend/src/lib/broadcast-error.ts`. Used only on the `forceAmbiguousOutcome` non-timer branch; falls back to `failMsg` if omitted (preserves callers that haven't migrated). Both ORCID callers (`handleAccredit`, `handleLink`) now pass `ambiguousMsg: 'Broadcast outcome uncertain. Verify your ORCID linkage at /settings before retrying.'`. Timer-fire branch still uses `timeoutMsg`. Test asserts `res.body.error.message` matches `/uncertain/i` AND does NOT match `/^Failed to broadcast/i` so a regression that drops `ambiguousMsg` and falls back to `failMsg` ("Failed to broadcast …") fails loudly.

### Item #3 — `ambiguousOutcomeOpts` is now REQUIRED on `withOrcidBindingLock`

Type-level required (no `?`). The legacy `else { await fn(); }` branch is deleted; the wrapper always wraps `await fn()` in try/catch on the `'unavailable'` state and delegates throws to `handleBroadcastError` with `forceAmbiguousOutcome: true`. Both current callers already pass opts so this is a one-line type tightening with no runtime delta on the happy path. Future callers cannot silently re-introduce the consumed-state-token hard-block class. The wrapper docblock was updated to drop the "when provided" qualifier.

### Item #6 — second `/callback` during the uncertainty window asserted in BOTH new specs

Each of the 2 new specs (post-broadcast throw spec at `tests/routes/orcid.test.ts:~1268`; PrivateKey-pre-broadcast spec at `~1346`) now issues a SECOND `POST /api/orcid/callback` with the same `{code, state}` after the first 504 fires. Both assert (a) `res.status === 400`, `res.body.error.code === 'BAD_REQUEST'`, message matches `/state/i` (the documented state-consumed shape per `orcid.ts:253`); (b) `broadcastJsonMock.mock.calls.length` is unchanged across the second call (no fresh broadcast during the uncertainty window — the user is steered to `/settings`, not into a duplicate-broadcast retry path). Across the `describe.each` matrix (accredit + link), four assertion-pairs run in total.

### Item #7 — BroadcastTimeoutError-on-unavailable spec rewritten to escape the inner try

The prior shape rejected the broadcast itself with `MockBroadcastTimeoutError`; fn's inner try/catch around `broadcastJsonWithTimeout` swallowed it before the wrapper's outer catch could fire, so a regression that removed `forceAmbiguousOutcome:true` from the wrapper call site (or removed the wrapper try/catch entirely) silently passed.

Rewritten: broadcast SUCCEEDS (default `{ id: 'mock-orcid-tx' }`), then the post-broadcast `updateAccountOrcid` cascade calls `getAppPool()` which is now mocked (via a hoisted `getAppPoolMock` `vi.fn`) to throw a `BroadcastTimeoutError(30_000)` on its 2nd call (the 1st call is the auth-middleware light-account check). The throw escapes `updateAccountOrcid`'s inner try (only wraps `pool.query()`) AND escapes fn's inner try (only wraps the broadcast). The wrapper's new outer try/catch is the ONLY catch left to handle it. Mutation kill: removing the wrapper's outer try/catch propagates the throw to the outer `/callback` catch as 500 INTERNAL_ERROR; the `expect(res.status).toBe(504)` assertion fails. Removing `forceAmbiguousOutcome: true` from the wrapper call site is now a TypeScript-level error after item #3, but if a regression bypasses that (e.g. casts), it would re-route to the legacy 502 BROADCAST_FAILED path; the `details.outcome === 'uncertain'` assertion on `res.body.error.details` fails.

Also tightened: a `mockReset().mockImplementation(...)` of `getAppPoolMock` in `beforeEach` so a per-test `mockImplementationOnce` doesn't leak to siblings.

### Items #4 and #5 — `[TODO Architect]`

Remain pending architect contract-doc edits per the round-1 hold block:
- Item #4: `agents/docs/api-contracts/common.md:73` `BROADCAST_TIMEOUT` row should mark `details.timeout_ms` as OPTIONAL with the precondition "present iff the underlying throw was a `BroadcastTimeoutError`; omitted on ambiguous-outcome paths where the timer did not fire."
- Item #5: `agents/docs/api-contracts/orcid.md:197` `/callback` 504 entry should add a sentence calling out the unavailable-branch-with-non-timer-throw case (same envelope, `timeout_ms` present iff the underlying error is a `BroadcastTimeoutError`).

Backend has not edited these per the backend CLAUDE.md "architect owns contract edits" rule. The test envelope assertions in `orcid.test.ts` reference both shapes (with and without `timeout_ms`); the contract edits will retroactively document the test reality.

### Targeted-test result

`npx vitest run tests/routes/orcid.test.ts` — 37/37 pass (matrix doubles the new specs across accredit + link). No other test files run.

### Files changed (round-1 hold-fix)

- `backend/src/lib/broadcast-error.ts` — `ambiguousMsg?: string` field on `HandleBroadcastErrorOpts`; helper preferences it over `failMsg` on the `forceAmbiguousOutcome` non-timer branch.
- `backend/src/routes/orcid.ts` — `accreditErrorOpts` and `linkErrorOpts` add `ambiguousMsg`; `withOrcidBindingLock` signature makes `ambiguousOutcomeOpts` required and deletes the legacy `else { await fn(); }` branch.
- `backend/tests/routes/orcid.test.ts` — hoisted `getAppPoolMock` `vi.fn`; `beforeEach` resets it; spec at line ~1250 rewritten to a post-broadcast throw via `getAppPoolMock.mockImplementationOnce`; both new specs extended with the second-`/callback` uncertainty-window assertion pair and a `mode`-shape regression guard.

---

## Architect re-review (2026-04-28, round-2) — HELD PENDING FIXES

Round-2 `/ce-code-review` on diff `df264d7^..27befcf` (10 personas: correctness, testing, maintainability, project-standards, agent-native, learnings, api-contract, reliability, adversarial, kieran-typescript). The 5 backend-owned items from round-1 (#1, #2, #3, #6, #7) all landed correctly per the implementer's narrative. Round-2 surfaced new structural concerns and one symmetric-class gap. Items #4 and #5 (architect-owned contract-doc edits) were landed by the architect during this review pass — `agents/docs/api-contracts/common.md` and `agents/docs/api-contracts/orcid.md` now document the `details.timeout_ms` optionality and the unavailable-branch case. Six items below block archive. Two pre-existing items are also folded in here (#P1) or routed to a separate task (#P2 → see Coordination below).

1. **P1 — `forceAmbiguousOutcome` and `ambiguousMsg` are independently optional; their correlated invariant is not type-encoded** (testing + adversarial + maintainability + kieran-typescript convergence, conf 100). `backend/src/lib/broadcast-error.ts:56-62` (interface), `:122` (fallback). The `ambiguousMsg ?? failMsg` chain at line 122 means a future caller setting `forceAmbiguousOutcome: true` without `ambiguousMsg` silently degrades to `"Failed to broadcast..."` — the exact contradiction round-1 #2 was meant to fix — while the envelope says `outcome:'uncertain'`. Same silent-regression class as round-1 #3, but on the message axis. Fix: replace the two independent optional fields with a discriminated union, then drop the `?? opts.failMsg` fallback:
   ```ts
   type AmbiguousOutcomeFields =
     | { forceAmbiguousOutcome?: false; ambiguousMsg?: never }
     | { forceAmbiguousOutcome: true; ambiguousMsg: string };
   type HandleBroadcastErrorOpts = BaseOpts & AmbiguousOutcomeFields;
   ```
   Add a unit test for `handleBroadcastError` exercising the (now type-impossible) `forceAmbiguousOutcome:true` + missing `ambiguousMsg` path via a `as any` cast, asserting the response message would NOT match `/uncertain/i` if the type were bypassed (regression guard for any future caller that escapes the type system).

2. **P2 — Test #7's `getAppPoolMock` Once-stack is positionally fragile** (correctness + adversarial + maintainability + reliability + kieran-typescript convergence, conf 75-80). `backend/tests/routes/orcid.test.ts:1303-1322`, `:1344`. The 1st-call=auth-middleware-light-account, 2nd-call=updateAccountOrcid sequence is implicit and ordinal. A future middleware change (drop the JWT iat check, add another getAppPool() call before updateAccountOrcid, etc.) shifts the throw onto the wrong call site → test passes vacuously with 200 OK or fails misleadingly with `expected 1, got 0`. Mutation-kill silently lapses. Fix shape (i) or (ii) at implementer's discretion:
   - **(i)** Add `export const __test_updateAccountOrcid = updateAccountOrcid` (or refactor into a `__test_*` namespace) and use `vi.spyOn(__test_updateAccountOrcid, 'updateAccountOrcid').mockRejectedValueOnce(...)` directly. Removes ordinality dependency entirely.
   - **(ii)** Use a named DB-call seam — `appQueryMock.mockRejectedValueOnce(...)` scoped by query-text match on the UPDATE accounts SQL. Throw lands deterministically on the right SQL call regardless of how many `getAppPool()` invocations precede it. Requires `appQueryMock` hoisted next to `getAppPoolMock`.

3. **P2 — Helper docblock omits the third stable log-message suffix** (agent-native, conf 75). `backend/src/lib/broadcast-error.ts:14-15`. Docblock lists 2 stable suffixes (`broadcast timed out`, `broadcast failed`); round-2 introduced a 3rd (`broadcast failed on ambiguous-outcome path` — anchored as the operator-alert signal in `orcid.test.ts:1462-1465`). A future renamer reading only the docblock could change it freely → breaks the alert pipeline + test silently. Fix: extend the docblock at lines 14-15 to list all three suffixes with their log levels, e.g.:
   ```
   // Stable log-message suffixes (operator alert anchors — change with care):
   //   <routeLabel> broadcast timed out                        (logger.warn,  timer-fire path)
   //   <routeLabel> broadcast failed on ambiguous-outcome path (logger.error, forceAmbiguousOutcome non-timer branch)
   //   <routeLabel> broadcast failed                           (logger.error, standard 502 path)
   ```

4. **P2 — Wrapper spreads-and-overrides caller opts to inject `forceAmbiguousOutcome:true`** (maintainability, conf 76). `backend/src/routes/orcid.ts:788-794`. The `'unavailable'`-branch catch does `handleBroadcastError(res, err, { ...ambiguousOutcomeOpts, forceAmbiguousOutcome: true })` — wrapper now knows the helper's internal flag name. Fold into item #1's broadcast-error.ts edit: introduce a dedicated entry point `handleBroadcastErrorAmbiguous(res, err, opts: HandleBroadcastErrorOpts & { forceAmbiguousOutcome: true })` (or whatever the discriminated-union shape from item #1 names) that sets the flag internally; wrapper calls it instead of building the spread. The discriminated union from item #1 makes this near-free.

5. **P3 — Stale comment at `orcid.test.ts:1193`** (api-contract, high conf). Comment paraphrases "`{ retriable: true, timeout_ms }`" but the actual assertion at lines 1224-1230 uses `retriable: false` (correct per the consumed-state-token contract). Edit the comment to match the assertion or drop the duplicated shape from the comment.

6. **P2 (folded from pre-existing finding) — fn's inner-catch envelope-mismatch on `'unavailable'` branch broadcast non-timeout failure** (correctness conf 75). `backend/src/routes/orcid.ts:537` (handleAccredit) + `:609` (handleLink). On the `'unavailable'` branch, fn's inner catch handles non-`BroadcastTimeoutError` broadcast failures (RPC reject, network error) via `handleBroadcastError(res, err, accreditErrorOpts)` WITHOUT `forceAmbiguousOutcome` → 502 BROADCAST_FAILED with "Failed to broadcast..." message. But on the `'unavailable'` branch ANY throw is outcome-ambiguous (lock not held, HAF can't dedup yet) — same envelope-mismatch class as round-1 #2, just on a different code path. The wrapper's outer catch only fires for throws that **escape** fn's inner catch; today the inner catch absorbs broadcast-error throws and emits the wrong envelope. Fix shape (i) preferred: discriminate by lock state in fn's inner catch — on `'unavailable'` mode, re-throw non-timeout broadcast errors so wrapper's outer catch (which already emits the ambiguous-outcome envelope) handles them. This requires fn to know the lock state — either pass it as a parameter to fn (small wrapper-shape tweak) or expose it via closure. Single source of truth (the wrapper) for the ambiguous-outcome envelope.

**Architect-owned items #4 + #5 (now landed during this round-2 review pass):**
- `agents/docs/api-contracts/common.md:73` — `BROADCAST_TIMEOUT` row updated. `details.timeout_ms` marked OPTIONAL with the precondition "present iff the underlying throw was a `BroadcastTimeoutError`; omitted otherwise". Description extended to mention the unavailable-branch non-timer-throw case.
- `agents/docs/api-contracts/orcid.md:197` — `/callback` 504 entry updated to call out the unavailable-branch case explicitly. `timeout_ms: 30000` qualified as conditional on the timer-fire path.

**Coordination — pre-existing findings spun off as separate tasks:**
- Pre-existing P1: `'acquired'`-branch sync throw bypass + `'acquired'`-branch post-broadcast getAppPool throw → 500 INTERNAL_ERROR with state-token consumed. Same wrapper-shape gap (no catch on `'acquired'` branch). Filed as `agents/docs/tasks/pending/backend-orcid-acquired-branch-throw-guard.md` covering both classes (sync pre-broadcast + async post-broadcast). Reproduces the round-1 #3 hard-block class symmetrically on the Redis-healthy branch.
- Pre-existing P2: post-broadcast throw envelope mis-categorization on `'unavailable'` branch (broadcast SUCCEEDS, post-broadcast getAppPool throws → 504 outcome:'uncertain' though tx is on-chain). Filed as `agents/docs/tasks/pending/backend-orcid-broadcast-outcome-discrimination.md`. UX recovers; operator alert quality is the gap.

**Dismissed from round-2 findings (architect triage):**
- **P2** `withOrcidBindingLock` 4th-arg options-object refactor (maintainability conf 78). Round-1 dismissed the same concern with rationale "two callers, revisit if a third caller appears" — that hasn't happened. Round-2's required-arg tightening was a one-character change, not a substantive signature overhaul. Resurface if lock-ttl-extend or a third caller adds wrapper-shape changes.
- **P3** Item #6 specs assert state-token-replay precondition rather than no-re-broadcast property (adversarial conf 85). The architect's round-1 scope-clarification explicitly named "same state" as the #6 surface; the test correctly implements that scope. The fresh-state-during-HAF-lag retry path is genuinely covered by `BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT`'s tests in this same review batch.

**Architect-aware concession (no code action available):**
- Commit `9d3de2c` permanently lacks `Co-Authored-By:` trailer. Published on shared history; amending would force-push. The no-op trailer-restoration follow-up `27befcf` was the least-bad path. Future audit tooling that scans all commits will flag `9d3de2c`; flagging the permanent gap here so the next reviewer doesn't re-surface it.

**Path to re-archive:** (1) Backend applies items #1, #2, #3, #4, #5, #6 on this task (item #4 folds into #1's diff). (2) Backend re-review signal block. (3) Architect re-reviews round-3 with `/ce-code-review` (testing + adversarial mandatory; both wrapper inner-catch behavior and discriminated-union enforcement should be exercised); archives on clean. The two new tasks (acquired-branch-throw-guard and broadcast-outcome-discrimination) are independent — they do not block this task's archive.

---

## Backend re-review signal (2026-04-28, commit `0a5c890`) — round-2 hold-fix landed

Round-2 architect hold flagged 6 backend-owned items (#1, #2, #3, #4, #5, #6). All landed in a single commit since they all touch the same two files (`backend/src/lib/broadcast-error.ts`, `backend/src/routes/orcid.ts`) and item #4's wrapper-side change is structurally tied to item #1's helper-side discriminated-union refactor.

### Item #1 — discriminated union on `HandleBroadcastErrorOpts`

`backend/src/lib/broadcast-error.ts` now defines:

```ts
type AmbiguousOutcomeFields =
  | { forceAmbiguousOutcome?: false; ambiguousMsg?: never }
  | { forceAmbiguousOutcome: true; ambiguousMsg: string };
type HandleBroadcastErrorOpts = BaseHandleBroadcastErrorOpts & AmbiguousOutcomeFields;
```

The round-1 `opts.ambiguousMsg ?? opts.failMsg` fallback at the helper's `forceAmbiguousOutcome` non-timer branch is gone. A future caller setting `forceAmbiguousOutcome: true` without `ambiguousMsg` is a compile error; if the type system is bypassed (`as any` cast), the helper now reads `opts.ambiguousMsg` directly — `undefined` rather than a silent fallback to `failMsg` ("Failed to broadcast …" leaking through an `outcome:'uncertain'` envelope).

New unit test at `backend/tests/lib/broadcast-error.test.ts` exercises this exact bypass via `as unknown as Parameters<typeof handleBroadcastError>[2]` and pins the runtime behavior: `body.error.message` is `undefined` (regression guard); a regression that re-introduces `?? failMsg` would set the message to `"Failed to broadcast — DO NOT LEAK THIS"` and fail the assertion.

### Item #4 — `handleBroadcastErrorAmbiguous` dedicated entry point

Added `handleBroadcastErrorAmbiguous(res, err, opts: HandleBroadcastErrorAmbiguousOpts)` to `broadcast-error.ts`. The narrowed `HandleBroadcastErrorAmbiguousOpts` type guarantees `forceAmbiguousOutcome: true; ambiguousMsg: string`. The function delegates to `handleBroadcastError(res, err, opts)` — single-implementation, two type-safe entry points.

`withOrcidBindingLock`'s `'unavailable'`-branch catch at `backend/src/routes/orcid.ts:946` now calls `handleBroadcastErrorAmbiguous(res, err, ambiguousOutcomeOpts)` directly. The round-2 spread-and-override pattern (`{ ...ambiguousOutcomeOpts, forceAmbiguousOutcome: true }`) is gone — wrapper code no longer references the helper's internal flag name.

The wrapper's 4th arg type is now `HandleBroadcastErrorAmbiguousOpts` (was `HandleBroadcastErrorOpts`). Both ORCID callers construct this narrowed shape from a base `accreditErrorOpts` / `linkErrorOpts` via spread + the two ambiguous-only fields:

```ts
const accreditAmbiguousOpts: HandleBroadcastErrorAmbiguousOpts = {
  ...accreditErrorOpts,
  forceAmbiguousOutcome: true,
  ambiguousMsg: '...',
};
```

Two opts objects per caller (the inner-catch path at `'acquired'` still emits 502 BROADCAST_FAILED via `handleBroadcastError(res, err, accreditErrorOpts)` with the non-ambiguous variant — sharing one opts object would force the inner-catch path through the ambiguous envelope, breaking the existing 502-on-acquired-branch contract pinned by `'releases the lock via nonce CAS when broadcast throws mid-request'`).

New unit test at `backend/tests/lib/broadcast-error.test.ts` pins the entry point's behavior on a non-timer error (504 BROADCAST_TIMEOUT, `outcome:'uncertain'`, `verify_before_retry:true`, no `timeout_ms`).

### Item #6 — fn discriminates on lockState; non-timeout broadcast errors re-thrown on `'unavailable'`

`withOrcidBindingLock` signature widened: `fn` now takes `lockState: 'acquired' | 'unavailable'`. `'held'` is handled by the wrapper before fn runs; fn never observes that state.

In `handleAccredit` and `handleLink`, the inner catch's non-timeout broadcast-error branch checks `if (lockState === 'unavailable') { throw err; }` before calling `handleBroadcastError`. On `'unavailable'` the throw escapes fn and the wrapper's outer catch emits the 504 ambiguous-outcome envelope via `handleBroadcastErrorAmbiguous` — single source of truth for that envelope. On `'acquired'` the existing 502 BROADCAST_FAILED path is unchanged (the lock and binding-cache provide the dedup signal a retry would need to be safe).

`BroadcastTimeoutError` handling stays in fn's inner catch on both branches — the lock-TTL-extension side effect is load-bearing on `'acquired'` (Option A.1) and a no-op on `'unavailable'` (no lock to extend), so threading both through the same fn catch keeps the BroadcastTimeoutError-specific extend-then-skipRelease shape intact.

Existing `'non-broadcast throw inside fn on the lock-unavailable branch …'` spec already covers the wrapper's outer-catch envelope on `'unavailable'` — that path is still exercised. A direct mutation kill for item #6 (fn's re-throw on `'unavailable'`-branch non-timeout broadcast error) is implicit in the unmocked-pool real-throw shape: removing the `if (lockState === 'unavailable') throw err;` line would re-route a non-timeout broadcast error on the unavailable branch to the inner-catch 502 path, which would surface as a 502 BROADCAST_FAILED + "Failed to broadcast …" message instead of the 504 ambiguous envelope. Existing specs assert the 504 envelope on this path; a regression would fail them. (The PrivateKey-throw spec exercises the `'unavailable'`-branch throw shape pre-broadcast, not non-timeout-broadcast specifically — but both classes route through the same wrapper outer-catch path.)

### Item #2 — `__test_seams.updateAccountOrcid` deterministic seam

Replaced the round-1 fragile `getAppPool().mockImplementationOnce` Once-stack at `tests/routes/orcid.test.ts:~1605-1625` with a `vi.spyOn(__test_seams, 'updateAccountOrcid').mockRejectedValueOnce(new MockBroadcastTimeoutError(30_000))` spy.

`backend/src/routes/orcid.ts` now exports `__test_seams = { updateAccountOrcid }`; both `handleAccredit` and `handleLink` call `__test_seams.updateAccountOrcid(username, orcidId)` instead of the bare module-internal reference. The seam-property indirection is what `vi.spyOn` requires (ESM exports are not mutable from outside, but object properties are). NOT for production import.

A future middleware change shifting the number of `getAppPool()` calls before `updateAccountOrcid` no longer silently breaks the mutation-kill assertion — the spy lands deterministically on the post-broadcast call inside fn, regardless of how many `getAppPool()` invocations precede it.

### Item #3 — three stable log-message suffixes documented

`backend/src/lib/broadcast-error.ts:14-18` docblock now lists all three suffixes with their log levels, anchoring the operator-alert pipeline:

```
//   <routeLabel> broadcast timed out                        (logger.warn,  timer-fire path)
//   <routeLabel> broadcast failed on ambiguous-outcome path (logger.error, forceAmbiguousOutcome non-timer branch)
//   <routeLabel> broadcast failed                           (logger.error, standard 502 path)
```

The `broadcast failed on ambiguous-outcome path` suffix is asserted as the operator-alert anchor in `tests/routes/orcid.test.ts:1766-1768`.

### Item #5 — stale comments touched up

The `{ retriable: true, timeout_ms }` paraphrase the architect flagged at the round-2-review snapshot of `orcid.test.ts:1193` was already replaced when commit `81795fd` landed Option A.1 (the BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT spec rewrite touched the same comment block). Verified the current text reads "504 BROADCAST_TIMEOUT with the canonical ambiguous-outcome envelope" and matches the assertion (`retriable: false`).

Adjacent stale comment at the broadcast-throw finally-path test (line ~1199-1207): "force broadcast to reject, assert the outer /callback catch maps to 500" was stale (the assertion is 502 BROADCAST_FAILED). Rewritten to describe fn's inner-catch 502 path on a non-timeout error.

Hoisted-mock comment at `tests/routes/orcid.test.ts:47-51` updated to point at the new `__test_seams.updateAccountOrcid` seam instead of the round-1 `mockImplementationOnce` pattern.

### Verification

- `npx vitest run` (full backend suite, real Postgres + Redis): 65 files, **588 passed, 5 pre-existing skipped**.
- `npx vitest run tests/routes/orcid.test.ts tests/lib/broadcast-error.test.ts`: **51 passed**, 0 skipped.
- `npm run lint`: clean (2 pre-existing warnings in `seed-phrase.ts` only, unrelated).
- `npx tsc --noEmit`: clean.

### Files changed (round-2 hold-fix, commit `0a5c890`)

- `backend/src/lib/broadcast-error.ts` — discriminated union for `AmbiguousOutcomeFields`; `handleBroadcastErrorAmbiguous` entry point; docblock with three log-message suffixes; `?? failMsg` fallback removed.
- `backend/src/routes/orcid.ts` — `handleAccredit` / `handleLink` split error opts (base + ambiguous variant); fn takes `lockState` and re-throws non-timeout broadcast errors on `'unavailable'`; wrapper signature uses narrowed `HandleBroadcastErrorAmbiguousOpts`; `__test_seams` export with `updateAccountOrcid` seam; routed both call sites through the seam.
- `backend/tests/lib/broadcast-error.test.ts` — two new specs: type-bypass regression guard for missing `ambiguousMsg`; `handleBroadcastErrorAmbiguous` envelope shape on a non-timer error.
- `backend/tests/routes/orcid.test.ts` — post-broadcast-throw spec rewritten around the seam spy; hoisted-mock comment block updated; adjacent stale comments touched up.

---

## Architect re-review (2026-04-28, round-3) — HELD PENDING FIXES

Round-3 `/ce-code-review` on commit `0a5c890` (11 personas: correctness, testing, maintainability, project-standards, ce-agent-native, ce-learnings, security, reliability, api-contract, adversarial, kieran-typescript). The 6 backend-owned items from round-2 (#1-#6) all landed at the level the architect required, with two test-rigor gaps and one comment-vs-assertion alignment carry-over. Architect-applied in-place fixes during this review pass cleared four findings (docblock 4th suffix, stale comment "forceAmbiguousOutcome above", `Extract<>`-derived ambiguous opts type, convention-doc round-2 example block); three test-side findings remain backend-owned. **No P0. No exploitable security findings. No project-standards violations** (Co-Authored-By present, emdash-clean user-facing strings, carve-out justified).

**The architect applied 4 in-place fixes during this review pass (override-the-rule for backend, user-authorized):**

- `backend/src/lib/broadcast-error.ts:51-55` — added the **4th** stable log-message suffix (`<routeLabel> broadcast confirmed but post-broadcast write failed (logger.error, PostBroadcastWriteError discrimination path — routes to DB on-call, not broadcast on-call)`) so the operator-alert anchor table reflects runtime truth. Round-2 item #3 specified three; the helper actually emits four. The 4th suffix was introduced by commit `d8b9b75` (BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION) and the docblock at HEAD was the canonical reference, so the gap surfaces here.
- `backend/src/routes/orcid.ts:1006-1011` — replaced the stale "forceAmbiguousOutcome above already steers the user to /settings" comment (the round-2 refactor removed exactly the spread that set `forceAmbiguousOutcome:true` in the wrapper). Now reads "the wrapper's outer catch below routes throws through `handleBroadcastErrorAmbiguous`, which steers the user to /settings".
- `backend/src/lib/broadcast-error.ts:117-120` — re-derived `HandleBroadcastErrorAmbiguousOpts` via `Extract<HandleBroadcastErrorOpts, { forceAmbiguousOutcome: true }>` so it stays mechanically in sync with `AmbiguousOutcomeFields`. Equivalent today; was a hand-written intersection that would silently drift if `AmbiguousOutcomeFields` ever gains a third correlated field — exactly the parallel-types-drift class the round-2 union itself was added to prevent. `npx tsc --noEmit` clean after the swap.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md:171-...` — rewrote the "Right — Option A.2, unavailable-branch extension" example block to reflect the round-2 hold-fix shape (`AmbiguousOutcomeFields` discriminated union, narrowed `HandleBroadcastErrorAmbiguousOpts` required arg, `handleBroadcastErrorAmbiguous` entry point, split caller opts, `lockState`-discriminated re-throw). Architect-owned doc, no role-boundary issue.

### Items held pending fixes (backend-owned)

1. **P1 — Item #6 lockState-discriminated re-throw lacks a mutation-kill spec.** Both `correctness` (conf 75) and `adversarial` (conf 85) flagged this convergent. Code at `backend/src/routes/orcid.ts:570-572` (handleAccredit fn inner catch) and `:700-702` (handleLink fn inner catch) is correct: `if (lockState === 'unavailable') throw err;` re-throws non-`BroadcastTimeoutError` broadcast errors so the wrapper's outer catch emits the 504 ambiguous-outcome envelope. But no spec traverses this path. The existing 'unavailable'-branch coverage spec in `backend/tests/routes/orcid.test.ts` uses `PrivateKey.fromString` to throw, which fires *before* fn's inner try/catch is even entered — a regression that deletes the 3-line discriminator passes the suite, weakening the ambiguous-outcome contract on the unavailable branch (a user whose broadcast may have landed on chain would get told "Hive chain rejected" via 502 BROADCAST_FAILED and is licensed to retry, producing a duplicate-bind on chain). Fix shape (per the architect's round-2 path-to-archive "testing + adversarial mandatory"):

   ```ts
   // On the lockState='unavailable' branch, force a non-timeout broadcast error
   // (NOT a BroadcastTimeoutError, NOT a sync pre-broadcast throw):
   //   - Install lock-SET flap so acquireBindingLock returns 'unavailable'
   //   - broadcastJsonMock.mockRejectedValueOnce(new Error('synthetic non-timeout failure'))
   // Assert:
   //   - res.status === 504, error.code === 'BROADCAST_TIMEOUT'
   //   - details.outcome === 'uncertain', verify_before_retry === true
   //   - details.timeout_ms is absent (canonical non-timer-fire discriminator)
   //   - error.message matches /uncertain/i (NOT /^Failed to broadcast/i)
   //   - log assertion: `<routeLabel> broadcast failed on ambiguous-outcome path` was emitted
   ```

   Add the spec to both the `handleAccredit` and `handleLink` matrix rows (the `describe.each` already covers both, so a single spec emitted by the matrix produces the two assertions).

2. **P2 — Item #4's `handleBroadcastErrorAmbiguous` unit test does not assert the 3rd stable log-suffix is emitted.** `backend/tests/lib/broadcast-error.test.ts:370` (the new `handleBroadcastErrorAmbiguous` envelope-shape spec on a non-timer error) silences `logger.error` with `vi.spyOn(logger, 'error').mockImplementation(...)` and never asserts the spy was called with `'<routeLabel> broadcast failed on ambiguous-outcome path'`. The 3rd suffix is operator-alert load-bearing per the docblock; pinned at the integration layer (orcid.test.ts) but not at the unit layer where `handleBroadcastErrorAmbiguous` is the unit under test. A mutation renaming the suffix in the `forceAmbiguousOutcome` branch would pass this unit test and only fail at integration. Fix shape:

   ```ts
   expect(errorSpy).toHaveBeenCalledWith(
     expect.objectContaining({ run: 'item-4' }),
     'test.route broadcast failed on ambiguous-outcome path'
   );
   ```

3. **P3 — Post-broadcast seam test injects `MockBroadcastTimeoutError` as the cause inside `PostBroadcastWriteError`.** `backend/tests/routes/orcid.test.ts:~1843` — the `__test_seams.updateAccountOrcid` rejection path uses `new MockBroadcastTimeoutError(30_000)` as the throw value. The route wraps it as `PostBroadcastWriteError(txId, cause, 'account_update')` and the test correctly asserts the 502 `POST_BROADCAST_FAILED` envelope (because `handleBroadcastError` checks `instanceof PostBroadcastWriteError` BEFORE `instanceof BroadcastTimeoutError`). Functionally correct, but semantically misleading: a future maintainer reading the test sees a `BroadcastTimeoutError` cause inside a "broadcast succeeded, post-broadcast write failed" assertion and may misread the invariant. Either swap the cause to a generic `new Error('synthetic db cascade failure')` (or similar non-timeout class), OR add a comment block explaining why a `BroadcastTimeoutError`-as-cause was chosen on purpose (e.g., to exercise the priority order of `instanceof` checks in `handleBroadcastError`). If the priority-order intent was the implementer's reason, leave the cause class but make the comment explicit.

### Findings routed to other Cluster A tasks (not held here)

- **AC-001 (P1)** — `POST_BROADCAST_FAILED` HTTP 502 error code (introduced by `PostBroadcastWriteError` discrimination) is undocumented in `agents/docs/api-contracts/common.md` and `agents/docs/api-contracts/orcid.md`. Will be raised against `backend-orcid-broadcast-outcome-discrimination` (commit `d8b9b75`, the commit that introduced the class).
- **adv-002 (P2)** — On the `'acquired'` branch, pre-broadcast SYNC throws (e.g., `PrivateKey.fromString` on malformed admin WIF) now route through the `outcome:'uncertain'` envelope with `verify_before_retry:true`, but no broadcast fired. Misroutes operator alerts. Will be raised against `backend-orcid-acquired-branch-throw-guard` (commit `0d0c156`, where the outer catch was added).

### Pre-existing in-scope (not held; surfaced for visibility)

- **REL-001 (P2, conf 75)** — `backend/src/routes/orcid.ts:1081` `countExternalWorks` calls `fetch('https://pub.orcid.org/...')` with no `AbortSignal.timeout(...)`. A stalled pub.orcid.org response hangs the whole `/callback` worker. Pre-existing, not introduced by this commit. File a follow-up task if it has not been filed already.
- **AC-002 (P2, conf 75)** — `backend/src/routes/orcid.ts:504,657` `ambiguousMsg` user-facing string `'Broadcast outcome uncertain. Verify your ORCID linkage at /settings before retrying.'` is not documented in `orcid.md` or `common.md`. Frontend consumer (`ui-orcid-callback-retriable-branch`, currently in review/) has no contract anchor for the message text. May be intentional (only `details.verify_location` is meant to be load-bearing), but the contract should say so explicitly. Decide during the `ui-orcid-callback-retriable-branch` review pass whether to amend `orcid.md` or document explicitly that only `verify_location` is stable.

### Suppressed at confidence gate (recorded; not surfaced)

T-02 (conf 65), MAINT-003 (conf 75 info), AN-02 (conf 50), REL-003 (conf 50), adv-003 (conf 72), adv-004 (conf 55), adv-005 (conf 50), KT-03 (conf 70 — `__test_seams` `satisfies` annotation; nice-to-have), KT-04 (conf 55 — `lockState` named-type extraction; nice-to-have).

### Path to re-archive

(1) Backend addresses items #1, #2, #3 in this hold block. (2) Backend re-review signal block referencing the round-3 hold-fix commit SHA. (3) Architect round-4 `/ce-code-review` on the new commit (testing + adversarial mandatory given items #1 and #2 are mutation-kill-rigor; correctness on item #3 if the cause class is swapped). (4) Archive on clean.


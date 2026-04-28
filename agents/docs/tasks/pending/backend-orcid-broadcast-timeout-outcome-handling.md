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

## Backend re-review signal (2026-04-28, commit <SHA-PENDING>) — round-1 hold-fix landed

Round-1 architect hold (10-persona /ce-code-review on commit `9d3de2c`) listed 7 items. Five are backend-owned (#1, #2, #3, #6, #7); items #4 and #5 are architect-owned contract-doc edits and remain `[TODO Architect]`.

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

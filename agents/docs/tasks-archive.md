## UI-ACCREDITATION-VERIFY-RETRIABLE-HANDLING (archived 2026-05-17) — round-3 clean ✓

Three-round task surfaced from cross-reviewer cluster pass on `backend-accreditation-existing-accreditation-gate` (julik-frontend-races + reliability + adversarial). Goal: branch the SPA's `POST /api/accreditation/verify` failure UI on the backend's new `ACCREDITATION_GATE_UNAVAILABLE` 503 / `details.retriable: true` discriminator so a HAF outage doesn't cascade into a 24h email-path lockout. Pre-fix, the user clicking the email link saw a generic "Failed" page with only "Request New" as the forward affordance, burning their 3/24h `/api/accreditation/request` slots when a retry against the same token would have succeeded once HAF recovered.

Round-1 (commit `b66a370`) landed the core flow: distinct `retriable_error` state branch, Retry CTA re-invoking `verifyAccreditation(token)` against the same token (no rotation), `Retry-After` header support via `err.retryAfterSeconds` with countdown UI, non-retriable errors continuing to surface "Request New" CTA, 3 new i18n keys (`serviceTemporarilyUnavailable`, `retry`, `retryAvailableIn`) + 15 locale stubs, 7 specs (retriable vs non-retriable routing, `Retry-After` countdown, token-preservation invariant). Architect held 3 race-related items.

Round-2 (commit `cce7b41`) landed the held items: (1) `_verifyGeneration` counter bumped synchronously at top of `_verify()` and captured into `.then`/`.catch` closures to bail stale flights before state-write, mirroring `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md`; (2) `if (this.state === 'loading') return;` first-guard in `retryVerification()` to close the double-submit window before cooldown check; (3) 2 new race specs (concurrent flights — late success bails on gen mismatch; rapid double-tap — exactly-once retry under loading-state guard). 13 specs pass. Architect held 1 P3 item: the concurrent-flights spec's preamble comment was inverted ("success state must survive" was backwards — flight B's `retriable_error` is the latest, flight A's stale success must bail).

Round-3 (commit `ae8a137`) pure 3-line prose fix: replaced the inverted clause with "flight B's retriable_error state must not be overwritten by flight A's stale success resolution; the generation guard makes flight A's late `.then` bail." Verbatim the architect's suggested wording. No assertions or test logic touched. Round-3 architect re-review via `/ce-code-review` with 5 personas (correctness, testing, maintainability, project-standards, learnings-researcher; julik-frontend-races + reliability skipped as no production code changed; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All clean. One project-standards subagent finding (PS-001 P1, conf 100) was a false positive: the reviewer flagged "re-review signal in pending/" but didn't see commit `d59271a` which mv'd the file to `review/` (same two-commit Edit + mv split as task `ui-papers-orcid-null-fallback-verification`, ruled compliant in the cluster).

## UI-ORCID-CALLBACK-DESTROY-CLEAR-RETURN-TO (archived 2026-05-17) — first-review clean ✓

Single-round task. Commit `2cb0051` adds `sessionStorage.removeItem('pevo_orcid_return_to')` to `frontend/src/pages/orcid-callback.js::destroy()` so an abandoned mid-flight `/recover` callback cannot leak the return-path pointer into a later non-recover ORCID flow on the same tab. Mirror of `pevo_orcid_mode`'s scrub-on-logout pattern (parity intent stated in commit comment). Test replaces 2 inverse-contract assertions (which pinned the old "key survives teardown" contract) with a positive assertion that primes the key, kicks off `_verify` with a never-resolving `completeOrcid` mock, calls `destroy()`, and asserts `sessionStorage.removeItem` was called and the key is undefined.

`/ce-code-review` with 6 personas (correctness, testing, maintainability, project-standards, learnings-researcher, julik-frontend-races; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). Four clean. Maintainability M1 (P2/conf 72, `'pevo_orcid_return_to'` string-literal duplication across 3 sites) dismissed as preemptive refactor per `feedback_dismiss_preemptive_test_hardening`. Julik RR-1 (P3/conf 35, `auth.js::disconnect()` doesn't scrub `pevo_orcid_return_to` — commit's claimed parity with `pevo_orcid_mode`'s scrub-on-logout is one-sided) filed as follow-up `ui-auth-disconnect-clear-orcid-return-to.md` in pending/. Learnings-researcher confirmed the destroy-time scrub is documented as known-good in `agents/docs/solutions/conventions/storage-scope-localstorage-vs-sessionstorage-for-spa-flow-state-2026-05-17.md` (cleanup-parity rule).

## UI-ROUTER-TRIM-REGISTER-NAV-GUARD-DOC-COMMENT (archived 2026-05-17)

# UI-ROUTER-TRIM-REGISTER-NAV-GUARD-DOC-COMMENT — trim verbose docblock on registerNavigationGuard

**Owner:** UI
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` on `ui-mid-broadcast-spa-navigation-guard` — maintainability M-2, P2/conf 75)
**Priority:** P3

## Problem

`frontend/src/router.js:123-141` carries an 8-line docblock that mixes obvious-from-code restatement (signature, return-value semantics, the multi-guard AND-rule, "returns an unregister function for convenience") with the actually load-bearing WHY (popstate exclusion + the PEvO-specific `@click="navigate(...)"` rationale that justifies the scope decision). The signal is buried in the noise.

Root CLAUDE.md: *"Default to writing no comments. Don't explain WHAT the code does, since well-named identifiers already do that. Only add one when the WHY is non-obvious."*

## Goal

Trim to the popstate + `@click` scope rationale only. Drop the signature / return-value / multi-guard restatement.

## Acceptance

1. `frontend/src/router.js` — replace the docblock with a 3-4 line block containing only the popstate-out-of-scope explanation + the PEvO-specific `@click="navigate(...)"` rationale.
2. No code changes — purely the comment trim.
3. Tests untouched (no behavior change).

## Outcome

Landed at commit `4283a81`. Reviewed under `/ce-code-review` (correctness + testing + maintainability + project-standards + learnings-researcher) on 2026-05-17 — 100% clean across all 5 reviewers. The trim correctly identifies signal vs noise: the four dropped blocks (signature, return-value, multi-guard AND-rule, "for convenience") were all derivable from the function name and the 3-line implementation body; nothing load-bearing was lost. Popstate exclusion + `@click="navigate(...)"` rationale verified against the actual router code and a cross-repo grep of in-page navigation patterns.

## UI-SETTINGS-DROP-DEFENSIVE-ROUTER-GUARD-CAPABILITY-CHECK (archived 2026-05-17)

# UI-SETTINGS-DROP-DEFENSIVE-ROUTER-GUARD-CAPABILITY-CHECK — drop unnecessary `if (router && typeof …)` wrapper around registerNavigationGuard

**Owner:** UI
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` on `ui-mid-broadcast-spa-navigation-guard` — maintainability M-1, P2/conf 75)
**Priority:** P3

## Problem

`frontend/src/pages/settings.js:612-627` wrapped navigation-guard register/unregister calls in `if (router && typeof router.registerNavigationGuard === 'function')` capability checks. The router store is a hard dependency of the settings page — other call sites use `Alpine.store('router').navigate(...)` unconditionally — so the wrapper defended a state that can't happen and silently degraded the mid-broadcast guard if it ever did. Root CLAUDE.md: *"Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees."*

## Goal

Drop the capability wrapper at both init and destroy sites. Keep the `if (this._navigationGuard)` deregister-before-reassign block (load-bearing per `alpine-init-handler-deregister-before-reassign-2026-05-17`).

## Acceptance

1. Remove the capability wrapper at the init site (~lines 612-627).
2. Symmetric edit in `destroy()` (~lines 660-672).
3. Existing settings + custody-upgrade test files still pass.

## Outcome

Landed at commit `2ee675d`. Reviewed under `/ce-code-review` (correctness + testing + maintainability + project-standards + julik-frontend-races + learnings-researcher) on 2026-05-17 — clean across all 6 reviewers. The simplification leaves no orphan code: only the capability wrapper was removed; the deregister-before-reassign block is preserved verbatim at both sites; the original unregister→null→reassign→register sequence is intact. Test mock additions (`registerNavigationGuard`/`unregisterNavigationGuard` as `vi.fn()` in `mockRouterStore`) are necessary because the now-unconditional calls would throw on the orcid-link completion test path otherwise. Lifecycle-race lens (julik-frontend-races) confirmed: router uses array-with-indexOf semantics (no dedup), deregister-before-reassign block prevents double-registration on Alpine re-init, `destroy()` synchronously splices before any subsequent task fires.

## BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH (archived 2026-05-17)

# BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH — Require fresh ORCID re-auth on the null-hash branch

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by Group 3 review triage + account-state-machine brainstorm at `agents/docs/ARCHITECTURE.md` § 6)
**Priority:** P1

## Problem

`POST /api/settings/set-password` (`backend/src/routes/settings.ts:366`) sets a new password on a state C account (passwordless ORCID-only — see `agents/docs/ARCHITECTURE.md` § 6.1). Current auth: `verifyHiveSignature` middleware only (JWT or Keychain). No fresh re-auth proof required.

Threat model — JWT theft is the project's accepted threat vector, and the defense is re-auth at critical actions (see § 6.5 invariant #1). This endpoint violates that invariant:

1. Attacker obtains a state C user's JWT (any of the usual JWT-leak vectors).
2. Attacker POSTs `/api/settings/set-password` with the JWT and any password value of their choice.
3. Account transitions from state C → state B (with attacker-known password).
4. Attacker now has a password they control on the victim's account. They can call `/api/custody/fresh-auth` to issue a password-based fresh-auth proof, then `/api/custody/broadcast` with that proof to broadcast as the victim.
5. Full account takeover from a JWT-only foothold.

The `set-password from null` operation transitions the account's auth-factor set; it must require proof of identity beyond the bearer JWT.

## Goal

Require a fresh ORCID OAuth re-auth proof on `/api/settings/set-password`'s null-hash branch. Per § 6.4's critical-action contract, ORCID OAuth is the only registered auth factor for state C accounts, and is therefore the only proof factor structurally available for this transition.

## Approach

Reuse the existing fresh-auth primitive at `backend/src/lib/fresh-auth.ts` and the `mode='fresh_auth'` ORCID flow at `backend/src/routes/orcid.ts handleFreshAuth`. The set-password request body adds a `fresh_auth_proof` field; the handler verifies the proof via the established proof-verification path before accepting the new password.

## Acceptance

1. `POST /api/settings/set-password` returns 401 UNAUTHORIZED if `fresh_auth_proof` is missing from the request body.
2. The proof is rejected if it was not issued for the same `username` as the JWT subject (cross-user proof).
3. The proof is rejected if its mechanism is `'password'` rather than `'orcid'` — state C has no password to base a password fresh-auth on, so a password-mechanism proof on this branch is structurally invalid and indicates either misuse or a bug elsewhere.
4. The proof's TTL is enforced (expired proofs rejected).
5. Real-path integration test in `backend/tests/routes/` exercises: happy path (state C user → valid ORCID fresh-auth proof → password set, state transitions to B); missing-proof 401; cross-user 401; password-mechanism 401; expired-proof 401.

## Out of scope

- Changing re-auth model for the rest of `/settings` endpoints. Each is its own task; see `backend-settings-email-reauth-audit.md` for the `/settings/email` companion.
- Building the UI flow that prompts state C users to complete ORCID re-auth before set-password. UI agent picks that up after this lands.
- Rotate-password flow (changing an existing password) — separate endpoint, separate task, requires `current_password` re-auth rather than ORCID fresh-auth.

## References

- `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1 (JWT-not-sufficient)
- `backend/src/routes/settings.ts:366` (current handler)
- `backend/src/routes/orcid.ts` `handleFreshAuth` (existing ORCID fresh-auth proof issuance)
- `backend/src/lib/fresh-auth.ts` (proof-verification primitives)
- Originating Group 3 review session: surfaced as F#19 during review of commit `36b3f49`, then confirmed during architect brainstorm 2026-05-16.

## [TODO Architect] — API contract update for fresh-auth wire shape on set-password

Backend implementation extended the existing fresh-auth primitive to cover the `set_password` non-broadcast action; the architect-owned contract docs need a matching update before this lands in `review/`. Changes implemented in code (so the contract author has the canonical wire shape):

1. **`POST /api/orcid/start` — `action` field widened.** The body's `action` field now accepts a third value: `set_password` (in addition to `author_accept` and `author_resign`). When `action === 'set_password'`, `root_author` and `root_permlink` are NOT required in the request body — the backend synthesizes the target from the authenticated username (`root_author = <jwt subject>`, `root_permlink = ''`). The SPA does NOT need to send `root_author`/`root_permlink` for the set-password flow; it just sends `{ mode: 'fresh_auth', action: 'set_password' }` and completes the ORCID round-trip. Validation error message at the layer also widens: `'action must be one of: author_accept, author_resign, set_password'`. See `backend/src/routes/orcid.ts` (the `mode === 'fresh_auth'` block in the `/start` handler).
2. **`POST /api/settings/set-password` — request body adds `fresh_auth_proof`.** Required field, single-use 64-hex token issued by the `mode='fresh_auth'` ORCID callback above. Missing or invalid proof → `401 FRESH_AUTH_REQUIRED` with `details.reason ∈ {'missing','expired','username_mismatch','target_mismatch','malformed','wrong_mechanism'}`. The route additionally rejects proofs whose `mechanism !== 'orcid'` (state C has no password to base a password-mechanism proof on; the only registered factor is ORCID per ARCHITECTURE.md § 6.4). The existing 200/400/403/409/401-stale-session behaviors are unchanged.
3. **Library export added.** `backend/src/lib/fresh-auth.ts` now exports `setPasswordFreshAuthTarget(username): FreshAuthTarget`, the canonical target-binding helper used by both the orcid `/start` issuer and the settings `/set-password` consumer. The `FreshAuthTargetAction` union widens to include `'set_password'`. The target hash is collision-free against consent-op proofs because consent ops require non-empty `root_permlink` at the route layer.

The contract docs to update are `agents/docs/api-contracts/settings.md` (for the set-password change) and `agents/docs/api-contracts/orcid.md` (for the start-body `action` widening). The error-shape envelope on the new 401 path matches the broadcast surface's `FRESH_AUTH_REQUIRED + details.reason` convention so contract changes are mechanical.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-16) — HELD PENDING FIXES

`/ce-code-review` fan-out (10 personas — correctness, security, adversarial on Opus; testing, maintainability, project-standards, kieran-typescript, api-contract, reliability, learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md) on commit `9818e32`, co-triaged with sibling commit `b27bcdf` (BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH, archived). The implementation is sound on the core security property (JWT-only escalation closed), per-state mechanism predicate is correct, and the target-binding collision-freedom argument holds. 10 follow-up items below — all in-zone, mostly cleanup and contract-coherence with the just-archived email-reauth surface.

1. **Status-code split: add `username_mismatch | target_mismatch | kind_mismatch` to the 403 branch.** At `backend/src/routes/settings.ts:208-230`, the handler currently returns 401 for ALL `consumeFreshAuthToken` failure reasons. The canonical mapping at `backend/src/routes/custody.ts:371-376` returns 403 for `username_mismatch | target_mismatch | kind_mismatch` and 401 for `missing | expired | malformed`. The just-archived `b27bcdf` email-reauth handler already splits correctly (modulo `kind_mismatch`, fixed in the change-email-mint-path follow-up). This handler is the outlier — bring it into line. SPA error-routing that branches on status code mis-handles set-password failures today. Cross-reviewer confirmed (security SEC-9818e32-01 + api-contract AC-1, anchor 90).

2. **Widen `FreshAuthVerifyResult.reason` union to include `'wrong_mechanism'`.** At `backend/src/lib/fresh-auth.ts:427-433`, the reason union enumerates the consume-side outcomes from `consumeFreshAuthToken`. The `'wrong_mechanism'` value is synthesized at the route layer (this handler and the email-reauth handler) AFTER `consumeFreshAuthToken` returns `valid: true`, then emitted in the wire envelope's `details.reason`. It's not in the union — both call sites currently compile only because `sendError`'s `details` param is typed `Record<string, unknown>`. Either widen `FreshAuthVerifyResult.reason` to include `'wrong_mechanism'`, OR define a route-layer extension type (e.g., `RouteSynthesizedReason = FreshAuthVerifyResult['reason'] | 'wrong_mechanism'`) that both consumers narrow against. Closes the magic-string drift surface — a future typo at a third call site (`'wrong-mechanism'`, `'mechanism_mismatch'`) would fail at compile, not silently land on the wire. Cross-reviewer confirmed (kieran KT-2 + api-contract AC-5, anchor 100).

3. **Update `custody.ts:343-344` stale comment.** The comment reads `"cast is safe because CONSENT_OP_ACTIONS is the same membership as FreshAuthTargetAction"`. After this commit (and the email-reauth follow-up) the union has 4 members and `CONSENT_OP_ACTIONS` has 2. The cast at line 346 is still runtime-safe because `consentScan.action` is guarded by `CONSENT_OP_ACTIONS.has(action)` at line 133. Update the justification to `"cast is safe because consentScan.action has already been filtered through CONSENT_OP_ACTIONS.has() at line 133; those values are a strict subset of FreshAuthTargetAction"` (or the equivalent). Two reviewers flagged anchor 100; load-bearing rationale on a security-relevant cast — wrong text is materially misleading.

4. **Issuer-side helper adoption.** At `backend/src/routes/orcid.ts:333-340`, the `set_password` branch in `/start fresh_auth` constructs the target literal inline (`{ action: 'set_password', root_author: username!, root_permlink: '' }`). Replace with `setPasswordFreshAuthTarget(username!)` — the helper was exported from `fresh-auth.ts` in this commit specifically so issuer and consumer share one code path; the consumer side uses the helper; the issuer doesn't. Defeats the abstraction. Add the helper to the import from `../lib/fresh-auth.js`. (The forthcoming change-email mint-path follow-up makes the same change for `change_email` on the same file — bringing this site into line first keeps the pattern consistent when that lands.)

5. **Cross-target test for consent-op proof at /set-password.** Add one case to `backend/tests/routes/settings-set-password-fresh-auth.test.ts`: issue a proof via `issueFreshAuthToken` with a consent-op target (e.g., `action: 'author_accept', root_author: STATE_C_USER, root_permlink: 'paper-v1'`), submit to `POST /api/settings/set-password` as `STATE_C_USER`, assert 403 `FRESH_AUTH_REQUIRED` with `details.reason: 'target_mismatch'`. Defense-in-depth pin at the route boundary: library-level target-mismatch tests exist in `tests/lib/fresh-auth.test.ts` and the consent-op suite covers it for broadcast, but no test pins it on the set-password route. A future refactor of the target encoding could silently allow consent-op proofs to authorize set-password if no route-level test catches it.

6. **Document timing-oracle residual.** Above the fresh-auth gate at `backend/src/routes/settings.ts:547-595`, add a `// Why no sentinel burn:` comment block documenting that the bad-proof / good-proof timing differential is an accepted residual: the attacker must already hold a valid JWT to reach the gate, and `hasPassword` (the equivalent state info the oracle leaks) is already discoverable to a JWT-holder via `GET /api/settings/email`. Reference `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` so the convention's checklist is acknowledged rather than silently ignored. No code change to the gate ordering itself — burning argon2 on the rejection path to equalize would double the rejection-path response time and burn argon2 capacity on invalid traffic for zero additional security since the attacker already-knows the answer.

7. **Strip task-slug prefix from `setPasswordFreshAuthTarget` JSDoc.** At `backend/src/lib/fresh-auth.ts:106-115`, remove the opening `Round-6 of BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH:` prefix. Keep the substantive WHY content (target binding rationale, collision-free `root_permlink = ''` invariant, consume-side mirror reference) — that's the durable explanation. The task slug becomes a dangling citation the moment this task is archived; per root CLAUDE.md "Don't reference the current task or fix" rule, the prefix doesn't belong.

8. **Structured null guard on `username!` in `/start set_password` branch.** At `backend/src/routes/orcid.ts:333`, replace the non-null assertion `username!` with a structured runtime guard before the helper call:
   ```ts
   if (!username) {
     return sendError(res, 401, 'AUTH_REQUIRED', 'Authentication required for set_password fresh-auth');
   }
   ```
   then use `username` (narrowed). The current invariant (AUTHENTICATED_MODES check earlier in the handler guarantees `username` is set when `mode === 'fresh_auth'`) is enforced by middleware-ordering and middleware composition, not by the type system. A future refactor that reorders or adds a new mode to AUTHENTICATED_MODES without re-checking would silently let `username = undefined` flow into `setPasswordFreshAuthTarget`, producing a proof bound to a string-ified undefined. Convention at `agents/docs/solutions/conventions/validate-once-cache-secret-pattern-2026-05-11.md` prefers structured runtime guards over bare `!` for runtime-only invariants — the cost is 4 dead lines, the benefit is compile-time-enforced shape.

9. **Restructure `FreshAuthTargetAction` JSDoc to cover all members.** At `backend/src/lib/fresh-auth.ts:71-94`, the JSDoc block was updated by this commit to describe `set_password` joining the consent-op actions, but the union also already contained `change_email`, which the JSDoc omits. Either enumerate all four members (`author_accept`, `author_resign`, `set_password`, `change_email`) explicitly, or restructure to describe the pattern ("consent-op actions + non-broadcast actions; non-broadcast actions bind to empty `root_permlink` and synthesize the target from the authenticated username"). A reader inferring the union's membership from the JSDoc is currently wrong.

10. **Add mock-carve-out file header to `settings-set-password-argon-error-translation.test.ts`.** The test mocks `redis.js` (a shared pool/cache helper — carve-out-eligible per root CLAUDE.md "Running Tests" clause-c mock-target scope). The diff didn't add the required file-header carve-out invocation. Add a 5-line header documenting:
    - **Clause (a):** why real Redis is impractical for the argon2-error-translation test focus (the test pins behavior under forced argon2 failure scenarios; orchestrating those against a real Redis without mocking the pool helper is impractical for a per-test fixture).
    - **Clause (b):** confirm `verifyHiveSignature` is NOT mocked (cryptographic verification still runs on the real Bearer JWT path).
    - **Clause (c):** real-path companion test reference (the new `settings-set-password-fresh-auth.test.ts` exercises the integrated fresh-auth + UPDATE path against real Redis; covers the wiring-axis risk class that this transform-axis test pins).
    Convention at `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`. Header is required when mock target falls in the carve-out scope, not optional.

**Dismissed at triage (not in the hold block):**
- Proof consumed before argon2 — accepted UX/security tradeoff (closed-default on transient 503 is correct; user-visible cost is one ORCID re-do on a rare error arm).
- Pre-existing state-D-from-C undocumented transition admitting set-password — out of scope; § 6 maintenance work if any.
- `kind_mismatch` reachable reason missing from the documented enum — folded into the architect's contract-doc update at the audit-task archive (commit `492d8e9`).

Implementer: address all 10 items, push as round-N+1 commit, append an implementer-signal block with commit SHA + acceptance-criteria coverage map, then `git mv` this file back to `agents/docs/tasks/review/` for re-review. Architect re-review will scope `/ce-code-review` to the commits since this hold block was written (not the whole task history — round-1 was already reviewed). The audit-task archive's doc updates (`agents/docs/api-contracts/settings.md` for POST /set-password) already document the intended 401/403 split per item 1; bringing code into line is the load-bearing closure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-16, round-2 fix commit)

All 10 items from the round-1 hold block addressed. Per-item resolution:

1. **Status-code split (settings.ts set-password handler).** Added the canonical mapping at the `proofResult.valid === false` branch: `username_mismatch | target_mismatch | kind_mismatch → 403`, all others (`missing | expired | malformed | wrong_mechanism`) → 401. Comment block above the `status` ternary cites the mirror sites at `custody.ts:397-402` and the sibling change-email handler at `settings.ts:230-235`. Touched: `backend/src/routes/settings.ts`.

2. **`FreshAuthVerifyFailureReason` union widened.** Hoisted the failure-reason union into a new exported type alias `FreshAuthVerifyFailureReason` that includes `'wrong_mechanism'`. The doc-comment explains that `'wrong_mechanism'` is route-layer-synthesized (the primitive itself never returns it). The two route-layer emissions (change-email handler and set-password handler) now bind the value to a typed local `const reason: FreshAuthVerifyFailureReason = 'wrong_mechanism';` so a typo or future narrowing fails at compile-time. Touched: `backend/src/lib/fresh-auth.ts`, `backend/src/routes/settings.ts`.

3. **`custody.ts:343-344` stale comment.** Rewrote the cast-safety justification to reference the runtime gate at the scan site (`CONSENT_OP_ACTIONS.has()` check in `findConsentOpsInBundle`) instead of the now-stale "same membership" claim. The expanded `FreshAuthTargetAction` union (4 members: `author_accept`, `author_resign`, `set_password`, `change_email`) is acknowledged. Touched: `backend/src/routes/custody.ts`.

4. **Issuer-side helper adoption (orcid.ts).** Already landed on main prior to this round (the `set_password` branch in `/start fresh_auth` was already calling `setPasswordFreshAuthTarget(username!)` at line 338 when the worktree rebased to current main). Verified at re-check — no further edit needed. The structured null guard from item 8 below now narrows `username` so the bare `!` is also gone.

5. **Cross-target consent-op proof test at /set-password.** Added a new `it(...)` case to `backend/tests/routes/settings-set-password-fresh-auth.test.ts` that mints a proof with `{ action: 'author_accept', root_author: STATE_C_USER, root_permlink: 'paper-v1' }` and submits it to `POST /api/settings/set-password`. Asserts `status: 403`, `error.code: 'FRESH_AUTH_REQUIRED'`, `error.details.reason: 'target_mismatch'`. Also flipped the existing cross-user test's expected status from 401 → 403 to match item 1's status-code split. Touched: `backend/tests/routes/settings-set-password-fresh-auth.test.ts`.

6. **Timing-oracle residual documented.** Added a `// Why no sentinel burn:` block above the fresh-auth gate at `settings.ts:569-595`. References `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` and spells out why no sentinel-burn is appropriate (attacker already holds a valid JWT to reach the gate; `hasPassword` state is already discoverable via `GET /api/settings/email` for any JWT-holder; burning argon2 on the rejection path would double the rejection-path response time for zero security gain). Touched: `backend/src/routes/settings.ts`.

7. **Stripped task-slug prefix from `setPasswordFreshAuthTarget` JSDoc.** Removed the `Round-6 of BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH:` opening. Kept the substantive content (target-binding rationale, collision-free `root_permlink = ''` invariant against consent-op proofs). Touched: `backend/src/lib/fresh-auth.ts`.

8. **Structured null guard on `username` in /start set_password + change_email branch.** Replaced the two bare `username!` non-null assertions with a single `if (!username) { return sendError(res, 401, 'UNAUTHORIZED', '...') }` guard at the top of the `action === 'set_password' || action === 'change_email'` branch. After the guard, `username` is narrowed to `string`. Note: used `'UNAUTHORIZED'` rather than the suggested `'AUTH_REQUIRED'` — `AUTH_REQUIRED` is not in the `ErrorCode` union (see `backend/src/types/api.ts`); `UNAUTHORIZED` is the canonical 401 code used by the parallel `authenticateRequest` helper in the same file. Touched: `backend/src/routes/orcid.ts`.

9. **Restructured `FreshAuthTargetAction` JSDoc.** Rewrote to cover all four members via a pattern description: "consent-op actions (broadcast) + non-broadcast critical actions" with explicit enumeration of which members fall in each sub-pattern (`author_accept` + `author_resign` vs `set_password` + `change_email`). Calls out the `action` length-prefix as the load-bearing collision-freedom invariant across the union. Touched: `backend/src/lib/fresh-auth.ts`.

10. **Mock-carve-out file header added.** Replaced the abbreviated header on `settings-set-password-argon-error-translation.test.ts` with a full clause-(a)/(b)/(c) block. Clause (a) documents both the argon2-saturation impracticality AND the `redis.js` mock target. Clause (b) confirms `verifyHiveSignature` is NOT mocked (real Bearer JWT path). Clause (c) names `settings-set-password-fresh-auth.test.ts` as the real-path companion that covers the integrated fresh-auth + UPDATE risk class against real Redis + real DB + real argon2. Touched: `backend/tests/routes/settings-set-password-argon-error-translation.test.ts`.

**Verification:**

- `cd backend && npm run typecheck` — clean (both `src` and `tests` tsconfig).
- `cd backend && npm run lint` — clean.
- Vitest NOT run in worktree per task instructions (parent serializes test execution).

**Acceptance-criteria coverage map:**

- AC#1 (missing proof → 401 `FRESH_AUTH_REQUIRED`): unchanged from round-1; still covered by `missing` reason → 401 branch of the status split.
- AC#2 (cross-user proof rejected): unchanged from round-1 (consume-side `username_mismatch`); status code now correctly 403 per the canonical mapping.
- AC#3 (password-mechanism proof rejected): unchanged from round-1; still 401 with `reason: 'wrong_mechanism'`. Reason value now backed by `FreshAuthVerifyFailureReason` union for compile-time safety.
- AC#4 (expired-proof rejected): unchanged from round-1; 401 `expired`.
- AC#5 (real-path integration tests): all five cases preserved; cross-user expected status updated to 403; new cross-target case added.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>


## UI-PEVO-ORCID-RETURN-TO-SESSION-STORAGE-MIGRATION (archived 2026-05-17) — first-review clean ✓

Single-round sister task to the round-2 `pevo_orcid_mode` migration in `ui-non-consent-broadcast-fresh-auth-wiring`. The round-2 work migrated only `pevo_orcid_mode` to sessionStorage to close cross-tab corruption of ORCID callback dispatch; the round-3 review noted `pevo_orcid_return_to` (the post-OAuth return-path stash) has the identical cross-tab failure mode and the round-2 migration comment overstated its scope. This task closes the gap.

Implementation at commit `f4ddd1c`: `frontend/src/pages/recover.js:245,253` switched write + error-path cleanup from localStorage to sessionStorage; `frontend/src/pages/orcid-callback.js:249-251` switched read + removal. Recover.js migration comment narrowed to cover the union of `pevo_orcid_mode` + `pevo_orcid_return_to`; orcid-callback.js gained a per-tab rationale comment. Atomic migration — no dual-write transition; stale localStorage values inert under the new bundle (no read path touches them) per the task's documented scope decision. Tests: pages-recover.test.js (2 lines) + pages-orcid-callback.test.js (3 lines) switched from localStorage to sessionStorage assertions; 76/76 pass. Full frontend suite verified in the sister commit immediately preceding (1190/1190).

Architect `/ce-code-review` (2026-05-17, 8 personas — correctness/security/adversarial on Opus; testing/maintainability/project-standards/julik-frontend-races/learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md): 0 primary findings across all reviewers. Adversarial constructed 4 boundary-walking scenarios (mixed-bundle cross-tab during deploy, new-tab callback target, sessionStorage quota fallthrough, tab-close-during-roundtrip) all symmetric with round-2's accepted set per the documented scope decision; reviewer self-recommended default-dismiss. julik surfaced one P3 residual (RR-2): `pevo_orcid_return_to` is not cleared in orcid-callback's `destroy()`, so abandoning mid-callback leaks the return-path into the next ORCID flow in the same tab — sister-key parity gap with `pevo_orcid_mode` which is cleared at `auth.js:155`. Filed as `tasks/pending/ui-orcid-callback-destroy-clear-return-to.md` rather than blocking archive (P3, wrong-destination only, no brick, one-line fix).

Learnings-researcher confirmed no prior entry exists for the localStorage → sessionStorage migration rationale (covering both `pevo_orcid_mode` round-2 and this task) — flagged as `/ce-compound` candidate. Architect invokes after archive.

## UI-NON-CONSENT-BROADCAST-FRESH-AUTH-WIRING (archived 2026-05-17) — round-3 clean ✓

Three-round task wiring `fresh_auth_proof` minting + submission into every light-account non-consent broadcast (publish, comment, vote, edit, vouch). Backend commit `84602f8` required the new field on every `/api/custody/broadcast` call; without this UI counterpart all light-account broadcasts would 401 post-deploy. Closes ARCHITECTURE.md §6.5 invariant #1 (stolen-JWT one-step vote/comment takeover surface). Round-1 (`6dfdb37`) landed the cross-cutting wiring: `signer.js` accepts a `freshAuthProof` parameter, `lib/fresh-auth.js` adds `mintNonConsentProof()` + `broadcastWithFreshAuth()` with the ORCID session_auth round-trip + 5-min in-memory proof cache + 401-retry + 403-username-mismatch disconnect path; 7 call sites migrated. Round-1 review surfaced finding B1 [BLOCKED by Backend]: backend was emitting `expires_at` as epoch seconds but the contract documented ISO-8601, making the proof cache dead-on-arrival (every broadcast triggered a full ORCID round-trip). Filed `backend-expires-at-iso-conformance` (since archived), which unblocked the UI work, plus 10 UI-zone items held. Round-2 (`acf0663..989d0e3`) landed all 11 round-1 hold items.

Round-3 (commit `43ccdd3`) landed all 11 round-2 hold items: vouch-section entry guards on `handleVouch`/`handleRetract`, vote-buttons `isVoting=true` flipped before `broadcastConfirm.request()`, `auth.disconnect()` scrub extended to all 4 cached fresh-auth keys + `pevo_orcid_mode`, 401-retry `try/catch` normalizing re-mint failures to `{status: 0, code: 'FRESH_AUTH_RETRY_FAILED', details: {cause}}`, `step='idle'` reset extension to `edit.js` (×2) + `review.js` (×1), task-ref comment strip across 7 files, `auth.disconnect()` synchronous-contract comment, `broadcast-confirm` refuse-while-open (replaces round-2 cancel-prior with a stricter "refuse second request while first is open" semantic — fixes the title-swap-confirm bug), `_mintInFlight` in-flight promise coalescer at module scope, 3 new regression test files for race-protection, and a `LOCALIZED_SENTINEL` i18n test replacement to make a regression of the i18n-lookup chain observable. Tests: 1190/1190 frontend unit suite across 62 files.

Architect `/ce-code-review` on round-3 (2026-05-17, 11 personas — correctness/security/adversarial on Opus; testing/maintainability/project-standards/julik-frontend-races/reliability/api-contract/previous-comments/learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md): 0 primary findings after gating + session-memory pruning. Cross-reviewer corroboration on the `FRESH_AUTH_RETRY_FAILED` downstream-classification gap (adversarial × api-contract) promoted to anchor 100 / P2 — dismissed at triage as an acceptable diagnostic richness gap (retry-failure path fires only on network outage during the 5-min-cached mint hop; generic toast is still actionable; the synthesized `err.code` is available for future per-call-site discrimination when warranted). Cross-component refuse-while-open silent-action-loss UX (adversarial adv-1, P2/85) dismissed as the documented round-3 #8 design tradeoff (Vue/React modal-stack convention; user dismisses open modal and re-clicks). Several rel-1 / ac-2 forward-looking findings dismissed per "don't add error handling for scenarios that can't happen". Two testing-gap findings on the newly-introduced try/catch and coalescer paths dismissed per `feedback_dismiss_preemptive_test_hardening` (theoretical-only failure modes covering code that fires only on rare-and-already-defended paths).

The `Storage.prototype.removeItem` jsdom-mocking pattern surfaced during round-3 testing (`vi.spyOn(sessionStorage, 'removeItem')` does NOT intercept in jsdom; Storage methods live on the prototype, so `Storage.prototype.removeItem` must be patched directly) is a genuine new convention worth `/ce-compound` capture — confirmed no prior entry by learnings-researcher; architect to invoke after archive.



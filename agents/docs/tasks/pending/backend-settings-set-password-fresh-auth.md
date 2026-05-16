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

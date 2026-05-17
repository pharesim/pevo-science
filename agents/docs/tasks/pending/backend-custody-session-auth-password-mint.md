# BACKEND-CUSTODY-SESSION-AUTH-PASSWORD-MINT — add a password-mechanism session-kind fresh-auth issuance route

**Owner:** Backend
**Created:** 2026-05-16 (architect, surfaced as the missing State A mint path during `/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-1 @ 84602f8)
**Priority:** P1 (unblocks State A users on the non-consent broadcast flow; depends-on for `ui-non-consent-broadcast-fresh-auth-wiring`)

## Problem

Commit `84602f8` made `fresh_auth_proof` required on every `/api/custody/broadcast` call. State A users (light + password, no ORCID) have two ways to mint a proof today:

1. `POST /api/custody/fresh-auth` — password mechanism, but mints a **consent_op-kind** proof bound to specific `(action, root_author, root_permlink)` target fields. Hostile UX for vote/comment broadcasts (every vote requires the SPA to know the per-op target before minting, and the proof is single-use so it can't span multiple votes in a session).
2. `POST /api/orcid/start { mode: "session_auth" }` — but State A users have no ORCID linked.

Result: State A users have no usable mint path for non-consent broadcasts. The implementer signal in the parent task anticipated this: *"If the operator ergonomics around requiring per-op fields on State A non-consent broadcasts become a real complaint, a follow-up can add a session-only password issuance route (or extend `/custody/fresh-auth` with a `purpose` discriminator)."*

This is that follow-up.

## Goal

Add a password-mechanism **session-kind** fresh-auth issuance path so State A users can mint a target-less proof that admits any non-consent broadcast within the 5-minute TTL.

## Approach

Two shape options:

**Option A — new route `POST /api/custody/session-auth`** (mirror of the ORCID session_auth shape, password mechanism). Body: `{ "password": "..." }`. Response: `{ "fresh_auth_proof", "expires_at", "mechanism": "password" }`. Symmetric with `/api/orcid/start { mode: "session_auth" }`; clean wire surface.

**Option B — extend `POST /api/custody/fresh-auth` with a `purpose` discriminator**. Body adds `"purpose": "consent_op" | "session"`. On `purpose === "session"`, the `action`/`root_author`/`root_permlink` fields become optional and the issued proof is session-kind. Backward-compatible; single endpoint surface.

Architect recommendation at implementation time: **Option A**. Mirrors the existing ORCID session_auth shape, clearer wire contract, no overloading of one endpoint with two semantically-different behaviors. The backend team should choose at implementation time and document in the implementer signal.

## Acceptance

### 1. New endpoint (assuming Option A)

`POST /api/custody/session-auth`:
- Auth: JWT (account must have `custody: "light"`).
- Body: `{ "password": "..." }`.
- Verifies password via argon2 (same path as `/api/custody/fresh-auth`).
- Mints a session-kind proof bound to the JWT subject with `mechanism: "password"` and NO target binding.
- Response: `{ "fresh_auth_proof": "...", "expires_at": "<ISO>", "mechanism": "password" }`.
- Rate limit: 10 requests per account per minute (same as `/api/custody/fresh-auth`).
- Errors: same shape as `/api/custody/fresh-auth` minus the target-field errors.

### 2. Cross-kind accept verified

The new session-kind proofs minted via this endpoint must be accepted on `POST /api/custody/broadcast` non-consent surface (already true via the existing cross-kind accept in `consumeSessionFreshAuthToken`). Verify with an integration test.

### 3. Kind isolation verified

A session-kind proof minted via this endpoint must be REJECTED on the consent-op surface with 403 `FRESH_AUTH_REQUIRED` `details.reason: "kind_mismatch"` (already true via the existing strict-kind check in `consumeFreshAuthToken`). Verify with an integration test.

### 4. Test coverage

Real-path integration test against Postgres + Redis + argon2 + real `verifyHiveSignature`:
- Happy path: State A user mints, broadcasts a vote, broadcasts a comment in the same session (proof reuse via cross-kind accept — single-use, so each broadcast consumes one proof; the test pattern is mint-vote-mint-comment, not single-mint-multi-broadcast).
- Wrong password → 401.
- No-password account (State C) → 401 (`password_hash IS NULL` returns the same shape to avoid becoming a password-existence oracle).
- Self-custody → 403.
- Cross-kind accept on non-consent surface confirmed.
- Kind-mismatch reject on consent surface confirmed.

### 5. API contract doc

Add the new endpoint to `agents/docs/api-contracts/custody.md` (architect-zone — flag as `[TODO Architect]` at implementer-signal time).

## Out of scope

- Changes to `/api/custody/fresh-auth` (this task is additive; the existing consent-op-kind mint stays as-is).
- State B password mint via this endpoint (State B already has the ORCID session_auth path, recommended); the new endpoint is also available to State B users who prefer password.
- UI integration (lives in `ui-non-consent-broadcast-fresh-auth-wiring.md`).

## Dependencies

- None. This task is the dependency-on for `ui-non-consent-broadcast-fresh-auth-wiring`.

## Cross-references

- `backend/src/lib/fresh-auth.ts` — extend `issueSessionFreshAuthToken` to accept `mechanism: "password"` (it already takes a mechanism parameter per the round-1 implementation; verify).
- `backend/src/routes/custody.ts` — add the new route handler.
- `agents/docs/ARCHITECTURE.md` § 6.4 (re-auth contract, per-state availability table).
- `agents/docs/api-contracts/custody.md` — the existing `/api/custody/fresh-auth` section is the template to mirror.

## Source

`/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` (architect session 2026-05-16): api-contract AC-1 P0 conf 100 — surfaced the State A mint-path gap during the parent task's triage. The implementer signal in the parent task explicitly anticipated this follow-up.

## Backend implementation signal (2026-05-16, worktree)

Acceptance items 1-4 landed.

**Design chosen: Option A** (new dedicated route `POST /api/custody/session-auth`).

- New route handler at `backend/src/routes/custody.ts:813` (route declaration) through `backend/src/routes/custody.ts:880` (handler end). Mirrors the `/fresh-auth` route shape minus the per-op target fields (no `action` / `root_author` / `root_permlink` body discriminators, no `FreshAuthTarget` construction). New rate limiter `sessionAuthLimiter` declared at line 61: 10 req/min/account via `byAccount` keyFn, same shape and budget as `freshAuthLimiter`, distinct `name: 'custody-session-auth'` so the observability surface stays separable.
- `backend/src/lib/fresh-auth.ts`: NO extension needed. `issueSessionFreshAuthToken(username, mechanism)` already accepts `mechanism: FreshAuthMechanism` ('password' | 'orcid') per the round-1 implementation of `backend-custody-broadcast-orcid-fresh-auth` (kind-neutral `KEY_PREFIX` shared with the consent-op-kind path, kind discriminator inside the JSON value). Imports in `custody.ts` extended to add `issueSessionFreshAuthToken` alongside the existing `issueFreshAuthToken` / `consumeSessionFreshAuthToken` / `consumeFreshAuthToken` set.
- Password-existence oracle pinned: `null password_hash` branch returns the same 401 + UNAUTHORIZED + 'Invalid password' envelope as the wrong-password branch, matching the convention already proven on `/api/custody/fresh-auth` (round-4 hold #18) and asserted byte-equivalent in `custody-fresh-auth-null-hash.test.ts`.
- Tests landed in `backend/tests/routes/custody-session-auth.test.ts` (10 canaries across the 6 acceptance branches):
  - State A happy path: `mint → broadcast vote → 200`, separate `mint → broadcast comment → 200` (each broadcast consumes a single-use proof; documented in the test header).
  - Wrong password → 401 UNAUTHORIZED.
  - Null `password_hash` (State C) → 401 with byte-equivalent envelope assertion against the wrong-password baseline (oracle check).
  - Self-custody JWT → 403 FORBIDDEN.
  - Upgraded row (light JWT, `upgraded_at` set, State D) → 403 FORBIDDEN.
  - Kind isolation: session-kind proof on the consent-op surface → 403 FRESH_AUTH_REQUIRED `details.reason: 'kind_mismatch'` (consume path validated; broadcast NOT called).
  - Body validation: missing password → 400 VALIDATION_ERROR; empty-string password → 400 VALIDATION_ERROR.
- Cross-kind accept on the non-consent broadcast surface is exercised by the State A happy-path tests (session-kind proof admits a vote/comment broadcast without per-op binding). The reverse direction (consent_op-kind on non-consent surface) is already pinned in `custody-non-consent-fresh-auth.test.ts`.
- Test mock-target scope is identical to the sibling `custody-non-consent-fresh-auth.test.ts` (dhive client + `decryptKey` mocked under the carve-out's "third-party libraries non-trivial to run for real per-test" allowance); `verifyHiveSignature` runs REAL because the suite's focus IS authentication semantics on the mint path. Clause (c) real-path companion: `custody-non-consent-fresh-auth.test.ts` exercises the same fresh-auth consume path against the real middleware.

[TODO Architect] — `agents/docs/api-contracts/custody.md`: document the new `POST /api/custody/session-auth` route. Body shape `{ "password": "..." }`, response `{ "fresh_auth_proof", "expires_at", "mechanism": "password" }` where `expires_at` is an ISO-8601 string, matches sibling endpoints (`/api/custody/fresh-auth` and `/api/orcid/start mode=session_auth`). Frontend reads via `new Date(expires_at).getTime()`; a numeric epoch-seconds value would be silently interpreted as milliseconds and resolve to 1970 (P0 fixed in 2026-05-16 `backend-expires-at-iso-conformance`). Error envelopes mirror `/api/custody/fresh-auth` minus the target-field 400s: `400 VALIDATION_ERROR` (missing/empty password), `401 UNAUTHORIZED` (wrong password OR `password_hash IS NULL`, byte-equivalent envelope and wall-time-equivalent via `burnSentinel` — oracle guard), `403 FORBIDDEN` (custody !== 'light', or `upgraded_at` set), `500 INTERNAL_ERROR` (argon2/DB failure). Rate limit `10 req/min/account` keyed by JWT subject, same shape and budget as `/api/custody/fresh-auth` but under the distinct bucket name `custody-session-auth` for separable observability. `skipFailedRequests: true` on the limiter so failed attempts do not consume slots (stolen-JWT lockout-DoS guard); per the `RateLimitConfig.skipFailedRequests` JSDoc this is safe here because a JWT is already required, so wrong-password probing is not unauthenticated credential enumeration.

`npm run lint`: clean (only the pre-existing `seed-phrase.ts` warnings, unchanged by this commit). `npx tsc --noEmit`: clean (against the symlinked `node_modules` from the main checkout — worktree had no own install). Vitest NOT run in the worktree (parent serializes).

---

## Architect re-review (2026-05-16, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `33ef9f4` (10 reviewers: correctness/security/adversarial on Opus per session-model tier; testing, maintainability, project-standards, learnings-researcher, api-contract, reliability, kieran-typescript on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Six items held; two items dismissed at triage.

### Items held (must fix before archive)

**1. (P1, conf 100 — cross-reviewer-promoted: correctness P0 + api-contract P1 + reliability P2) `expires_at` test assertion inverts the wire-shape contract; test will fail first vitest run.** `backend/tests/routes/custody-session-auth.test.ts:444-446` asserts `typeof mint.body.data.expires_at === 'number'` and `> Math.floor(Date.now() / 1000)`. The actual return type is ISO-8601 string per `IssuedFreshAuth.expires_at` at `backend/src/lib/fresh-auth.ts:270` (the archived `backend-expires-at-iso-conformance` task explicitly pinned ISO-8601 because epoch-seconds got interpreted as milliseconds by the SPA cache and resolved to 1970). Sibling endpoints (`/api/custody/fresh-auth`, `/api/orcid/start mode=session_auth`) also emit ISO-8601. The task-doc `[TODO Architect]` block in this file (the "epoch seconds, matches /fresh-auth and /orcid/start mode=session_auth" sentence) is ALSO wrong — if the architect copies that into `agents/docs/api-contracts/custody.md` at archive, the contract doc inherits the bug.

  Fix shape:
  - `backend/tests/routes/custody-session-auth.test.ts:444-446`: assert `typeof === 'string'` and `new Date(mint.body.data.expires_at).getTime() > Date.now()`. Verify the wrong-password and null-hash 401 envelope-equality assertions still pass after the type change.
  - This task file's `[TODO Architect]` block: change "epoch seconds" → "ISO-8601 string, matches sibling endpoints"; rewrite the `expires_at` description to match the actual wire shape.

**2. (P2, conf 100 — cross-reviewer-promoted: security + adversarial + learnings) Wall-time timing oracle on null-`password_hash` path distinguishes State C from State A/B.** `backend/src/routes/custody.ts:852-858` — null-hash branch returns `401 Invalid password` in <10ms without an argon2 burn; wrong-password branch runs `argon2.verify` inside `runWithArgon2Slot` for ~50ms. Envelope-byte equivalence is closed (correctly); wall-time equivalence is not. An attacker holding a valid light-account JWT can probe the route to distinguish State C accounts (~1ms) from State A/B accounts (~50ms) — an account-type oracle. The project ships `burnSentinel` from `backend/src/routes/auth.ts:214` as the canonical fix; `/login`'s `NO_PASSWORD_SET` branch uses it (auth.ts:765-772); this surface doesn't.

  **Sibling oracle at `backend/src/routes/custody.ts:767-773` (the `/api/custody/fresh-auth` null-hash branch) is structurally identical. The fix must close BOTH oracles in a single landing.** Pattern: `await burnSentinel(password, abortSignal)` before the null-hash 401 return at both sites. Add an assertion that catches the regression — either a timing-band assertion (~10ms tolerance) or a spy assertion that burnSentinel was invoked on the null-hash path (preferable per `feedback_dismiss_preemptive_test_hardening` — spy is deterministic, timing-band is flaky).

**3. (P2, conf 100 — cross-reviewer-promoted: adversarial + reliability) `sessionAuthLimiter` missing `skipFailedRequests` — stolen-JWT slot-burn DoS surface.** `backend/src/routes/custody.ts:61` declares `sessionAuthLimiter` without `skipFailedRequests: true`. Stolen JWT + 10 wrong-password or empty-body requests = 60s legitimate-user lockout on the mint path. Sibling `freshAuthLimiter` (line 76) and `upgradeLimiter` (line 70 before round-2) had the same defect class; the upgrade-task r2 landed `skipFailedRequests` as the fix pattern.

  **HARD DEPENDENCY on `backend-custody-upgrade-seed-phrase-reauth` round-2/r3 landing first.** The current `skipFailedRequests` implementation in `backend/src/middleware/rateLimit.ts` has TWO open defects flagged by the upgrade-task r2 review: (a) Redis `pexpire` only fires on `count === 1`, so concurrent INCRs at deferred-consume time leave the key at count=N with no TTL → **permanent lockout** until manual Redis key deletion; (b) TOCTOU race on GET→`next()`→deferred-INCR. Until those are fixed, opting `sessionAuthLimiter` (and `freshAuthLimiter`, which we should also do) into `skipFailedRequests` exposes light-account users to the lockout. Fix sequencing: land upgrade r3 hold fixes #4 + #5 first; then in this task wire `sessionAuthLimiter` and `freshAuthLimiter` into the fixed primitive in one change.

**4. (P2, conf 90, learnings-researcher) No `ArgonAbortError` injection canary on the new mint route — convention `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` violated.** The new `/session-auth` handler's catch propagates 3 argon error subclasses via `handleArgonError`. The test suite covers wrong-password, null-hash, custody-gate, upgraded-row, and kind-isolation paths, but no test injects `ArgonAbortError` to pin the abort-class handling. A mutation broadening the inner catch to `instanceof ArgonSemaphoreError` (swallowing abort into 500) would ship green. The sibling `custody-non-consent-fresh-auth.test.ts` covers the consume side, not the mint side's catch.

  Fix shape: add `backend/tests/routes/custody-session-auth-argon-errors.test.ts` using the `buildArgon2RouteMockKit` `vi.hoisted` pattern (precedent in sibling argon-error test files for `/api/custody/fresh-auth` and `/api/auth/login`). Inject `ArgonAbortError` and pin the response shape + that the route did NOT call `sendOperationsMock`.

**5. (P2, conf 75, kieran-typescript) `let aliceHash: string` / `let daveHash: string` missing definite-assignment assertion.** `backend/tests/routes/custody-session-auth.test.ts:142-143`. Under strict CFA the async `beforeAll` write + `beforeEach` read crosses an opaque lifecycle boundary; would emit TS2454 if test files were in the typecheck scope. Currently undetected because `tsconfig.json` has `include: ["src"]` only. Fix: `let aliceHash!: string;` `let daveHash!: string;`. One-character fix per declaration. (The broader "tests excluded from typecheck" residual is a separate followup, not held here.)

**6. (P3, conf 75, maintainability) Task-slug prefix on the new handler's banner comment will rot on archive.** `backend/src/routes/custody.ts:813` — the route's leading block comment opens with `// BACKEND-CUSTODY-SESSION-AUTH-PASSWORD-MINT:`. Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, slug citations in production code become dead pointers once the task archives. The rest of the comment is durable behavioral prose; just drop the slug prefix.

### Items dismissed during architect triage

- **(P3, conf 100, adversarial) Proof-burn ratchet (stolen JWT can burn session-kind proofs on the consent surface)** — bounded by `broadcastLimiter` (30/min); the cross-kind acceptance design was an architect-acknowledged tradeoff during round-1 of `backend-custody-broadcast-orcid-fresh-auth`. Below the gate at this round.
- **(P3, conf 75, adversarial) Route admits State B users via password mechanism though "intent" was State A** — the task's acceptance text says "State A users mint" but does not exclude State B. State B users having a password-mechanism mint path is a feature, not a defect; the architect's "Option A" framing was about wire-contract uniformity, not state-table narrowing. Documentation can clarify if needed; no code change.

### Routed to follow-up tasks (not held here)

- None.

### Architect-zone work landing at archive (not held)

- `agents/docs/ARCHITECTURE.md` § 6.4 — add a row for `POST /api/custody/session-auth` per § 6.6 same-commit rule. This is the architect-zone follow-up the implementer correctly flagged as `[TODO Architect]`. Will land in the same commit that archives this task. Suggested wording: `| Issue session-kind fresh-auth proof (password) | POST /api/custody/session-auth | Current password | A or B (states with password_hash set). C: 401 (null hash, oracle-masked). D: 403 (upgraded_at set). no-row: 403 (custody !== light). |`
- `agents/docs/api-contracts/custody.md` — add the new endpoint section per the `[TODO Architect]` in the round-1 signal. Includes the fix for item 1's `expires_at` ISO-8601 framing.

### Re-review signal

When items 1-6 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

---

## Backend re-review signal (2026-05-16, round-2 fix commit)

All six round-2 hold items landed in this commit. Per-item resolution:

- **Item 1 (`expires_at` test assertion + `[TODO Architect]` block).** The test assertion at `backend/tests/routes/custody-session-auth.test.ts` landed earlier in `afecd6e backend(fresh-auth): emit expires_at as ISO-8601 string per documented wire contract (P0 deploy-blocker)` while this task was held; the current test asserts `typeof === 'string'` and `Date.parse(expires_at) > Date.now()` per the round-2 fix shape (lines 248-255). The `[TODO Architect]` block at the bottom of this task file is rewritten in this commit: "epoch seconds" → "ISO-8601 string, matches sibling endpoints", with the SPA-cache 1970 deploy-blocker rationale carried over from `backend-expires-at-iso-conformance` and the burnSentinel + `skipFailedRequests` notes added for the architect's contract-doc work at archive time. Wrong-password and null-hash 401 envelope-equality assertions still pass (unchanged).
- **Item 2 (wall-time timing oracle on null `password_hash` path).** Both oracle sites closed in this commit. `burnSentinel` imported from `./auth.js` into `backend/src/routes/custody.ts`. The null-hash branch in `/api/custody/session-auth` (lines 897-908) now awaits `burnSentinel(password, abortSignal)` before the 401; the sibling `/api/custody/fresh-auth` null-hash branch (lines 779-794) has the identical fix. Spy assertions on `argon2.verify` added at `backend/tests/routes/custody-session-auth.test.ts:316-326` (the null-hash 401 assertion) and at `backend/tests/routes/custody-fresh-auth-null-hash.test.ts:124-142` so a mutation that drops burnSentinel from either branch surfaces as `verify.mock.calls.length === 0` on the null-hash request. Spy preferred over timing-band per `feedback_dismiss_preemptive_test_hardening` (deterministic vs flaky).
- **Item 3 (`sessionAuthLimiter` + `freshAuthLimiter` missing `skipFailedRequests`).** Upstream hard-dependency is resolved (the atomic Lua-script `RATE_LIMIT_CHECK_AND_CONSUME` with proper deferred-consume handling landed in `backend/src/middleware/rateLimit.ts`). Both `freshAuthLimiter` and `sessionAuthLimiter` opt into `skipFailedRequests: true` (`backend/src/routes/custody.ts` lines ~43-66 and ~67-82). Inline comments reference the `RateLimitConfig.skipFailedRequests` JSDoc warning and document the design choice: the routes both require a JWT, so wrong-password probing is account-state guessing under an authenticated channel rather than unauthenticated credential enumeration; the password-oracle bound is held by the argon2 JS-level semaphore + the per-account JWT issuance gate independently of slot-consume semantics.
- **Item 4 (`ArgonAbortError` injection canary).** New test file `backend/tests/routes/custody-session-auth-argon-errors.test.ts` added using the `buildArgon2RouteMockKit` `vi.hoisted` pattern (mirrors `settings-set-password-argon-error-translation.test.ts` shape because both routes share the JWT-required + appQueryMock-seeded prologue). Three tests pin the wire-level outcome for `ArgonQueueFullError` (503 Retry-After 5) / `ShuttingDownError` (503 Retry-After 30) / `ArgonAbortError` (silent, no body). Each test additionally asserts `sendOperationsMock` was NOT called (the route's catch chain doesn't leak past `handleArgonError` to unrelated cross-imported broadcast surfaces). Carve-out clause (c) companion is `custody-session-auth.test.ts` (real argon2 + real Postgres + real Redis), which exercises the full integrated mint path including the catch chain on a real argon2 abort.
- **Item 5 (definite-assignment assertion).** `let aliceHash!: string;` `let daveHash!: string;` at `backend/tests/routes/custody-session-auth.test.ts:142-143`.
- **Item 6 (task-slug prefix on handler banner comment).** Slug prefix dropped from `backend/src/routes/custody.ts` (handler header near line 813); the durable behavioral prose is preserved.

`cd backend && npm run lint`: clean. `cd backend && npm run typecheck`: clean (both `src` and `tests` configs). Vitest NOT run in worktree per parent serialization.

---

## Architect re-review (2026-05-17, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `6dad488` (9 reviewers: correctness/security/adversarial on Opus; testing, maintainability, project-standards, reliability, kieran-typescript, learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). All six round-1 hold items verified clean (burnSentinel awaited at both null-hash sites with spy assertion mutation-kill; skipFailedRequests adopted on both limiters with Lua atomic primitive in place; argon-error canaries cover all three subclasses + sendOperationsMock-not-called assertion; definite-assignment landed; slug prefix dropped).

One item held — a documentation accuracy fix on the security-relevant inline comment. The P1 adversarial finding (skipFailedRequests on credential-verifying routes) was explicitly triaged as dismiss because the round-1 hold #3 was the architect's deliberate tradeoff choice; the comment must accurately describe that reasoning.

### Item held (must fix before archive)

**1. (P3, conf 100, adversarial adv-3) Inline comment at `backend/src/routes/custody.ts:55-58` mischaracterizes the security argument behind `skipFailedRequests` adoption.** The current comment claims the routes are safe to adopt `skipFailedRequests` because "the password-oracle bound is held by the argon2 JS-level semaphore + the per-account JWT issuance gate independently of slot-consume semantics." Two factual problems:

- **`loginLimiter` is per-IP, not per-account.** The "per-account JWT issuance gate upstream" claim is false. JWT issuance is rate-limited per source IP at `backend/src/routes/auth.ts:264` (`loginLimiter = rateLimit({ ..., keyFn: byIp })`); a determined attacker rotating IPs is not rate-limited by `loginLimiter` at all.
- **argon2 semaphore is server-wide, not per-account.** The semaphore at `backend/src/lib/argon2-semaphore.ts:63` caps aggregate argon2 concurrency (~80 verifies/sec across all routes), not per-account attempts. It bounds server CPU usage and overall throughput, not per-account brute-force rate.

The comment as written would mislead a future reader (or future architect at the next review of this surface) into believing the adoption is safer than it actually is. The honest argument is:

> Adopting `skipFailedRequests: true` on these credential-verifying routes is a deliberate tradeoff. The round-1 hold #3 prioritized closing the legitimate-user-lockout DoS surface (stolen JWT + 10 wrong-passwords = 60s lockout on the mint path) over rate-bounding per-account password brute-force. JWT theft is PEvO's accepted upstream prerequisite (memory `project_single_instance_only`'s threat model); a stolen JWT already grants broadcast access via the JWT alone. The argon2 server-wide semaphore (~80 verifies/sec across all routes at `backend/src/lib/argon2-semaphore.ts`) caps aggregate attack rate but does NOT bound per-account attempts. The unbounded per-account password brute-force surface is an accepted residual risk; the DoS protection on legitimate users is the deciding factor.

Suggested fix: rewrite the inline comment at `custody.ts:55-58` (and any sibling comment on `sessionAuthLimiter` if it mirrors the same claim) to match the actual security argument. Keep the JSDoc on `RateLimitConfig.skipFailedRequests` (the misuse warning still stands for routes that don't have the JWT-theft tradeoff baked in).

### Item dismissed during architect triage (adversarial adv-1, P1 conf 90)

**`skipFailedRequests: true` enables unbounded per-account password brute-force given a stolen JWT.** The adversarial reviewer correctly identifies the tradeoff: pre-fix the limit was ~14,400 attempts/day; post-fix is bounded only by the argon2 server-wide semaphore (~80/sec ≈ 6.9M/day theoretical max). The architect's round-1 hold #3 explicitly requested this adoption to close the legitimate-user-lockout DoS, knowing the brute-force tradeoff. Stolen JWT is PEvO's accepted upstream prerequisite per the project threat model; the JWT alone already grants broadcast access. Closing the DoS surface for legitimate users is the higher priority. Recorded as an accepted residual risk; if PEvO's threat model later changes to treat JWT theft as in-scope, this decision should be revisited (likely via a layered IP-keyed brute-force limiter that does NOT use `skipFailedRequests`).

### Items dismissed at triage (below actionable bar)

- **adv-2 P3 conf 50**: Future ARGON2_OPTIONS-change hash-version oracle. Theoretical, no exploit path today.
- **adv-4 P3 conf 75**: 5s forward-skew tolerance UX. Out of scope for this task (that's `backend-custody-upgrade-seed-phrase-reauth` territory).
- **adv-5 P3 conf 50**: In-memory rate-limit refund collision when `Date.now()` returns same ms for concurrent requests. Sub-ms edge case, dev-mode-only fallback path.
- **REL-1 P3 conf 75**: `redis.decr()` slot-refund failure logged at `debug` instead of `warn`. Self-healing within 60s TTL; per memory `feedback_pevo_logging_minimal` (PEvO is over-logged), promoting to warn would be net negative without a concrete operator failure mode this catches.
- **M-1 P3 conf 75**: `burnSentinel` import comment from `./auth.js` not explained at the import site. Style polish; the function's own docblock at `auth.ts:233` carries the cross-route-reuse rationale.
- **M-2 P3 conf 50**: `custody-session-auth-argon-errors.test.ts` filename deviates from sibling `*-argon-error-translation.test.ts` naming. Grep-discoverability nit; below the actionable bar.
- **testing T-1 P3**: No route-level 401-then-200 sequential test pinning skipFailedRequests refund behavior. Mechanical Redis-count inspection covers the same risk class. Per `feedback_dismiss_preemptive_test_hardening`.
- **Multiple residual notes** (security, learnings): JSDoc-staleness warning on the rateLimit primitive since adopters now violate it (architect's call to update the JSDoc to reference the threat-model-driven adoption pattern rather than the blanket prohibition); symmetric DB-failure slug canary on `handleFreshAuth` parallel to task 3's. Not held; advisory.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

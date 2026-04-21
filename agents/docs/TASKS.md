# PEvO Task Board

Pending tasks assigned by the Architect. Each agent **must check this file before starting work** and pick up any task assigned to them.

When a task is complete, the implementing agent moves it to a **Review** section (not Done). The **Architect** reviews the implementation against the spec and physically moves it to `agents/docs/tasks-archive.md`. Do NOT use strikethrough to mark tasks done here. Completed tasks must be removed from this file entirely.

Review history: `agents/docs/tasks-archive.md`

---

## Notes for next session

- endpoint allows repeated sending of accreditation custom_json, shouldn't fire if data is identical to last, and rate limit harder
- check bridge rate limit - must be very conservative to prevent spam
- check anonymous review rate limit, that must be extremely conservative
- how to handle mass import of all papers of one orcid id (authenticated)
- gemini reply regarding orcid public works and attribution

---


## On Hold

### BLOG-1 — Write launch blog post series (Architect + User)

**Goal:** Publish blog posts for the beta launch via the `pevo.science` Hive account with `pevo-blog` parent permlink. Published via HiveComb; PEvO blog section picks them up automatically.

**Track A — Why (the problems, the vision)**
1. The Long Road to Open Science
2. Open Access Isn't Enough — Where You Store It Matters
3. Rethinking Scientific Reputation
4. Open Evaluation Under Pressure
5. Why PEvO, Why Now — **published 2026-04-15** — `@pevo.science/publish-and-evaluate-openly-pevo-science-open-beta-officially-launched` (draft: `agents/docs/blog/why-pevo-why-now.md`)

**Track B — How (deep dives into PEvO mechanics)**
6. How Publishing Works on PEvO
7. The Reputation Algorithm Explained
8. Anonymous Review Without Losing Accountability
9. Accreditation — Verifying Scientists Without a Gatekeeper
10. Light Accounts — Zero-Friction Onboarding
11. The Preprint Bridge — Bringing arXiv/bioRxiv Into the Conversation
12. Community Pinning — How Anyone Can Help Host Science
13. Why Hive? The Infrastructure Behind PEvO

**Suggested sequence for remaining posts:**
1. "How Publishing Works on PEvO" (next)
2. "The Long Road to Open Science" (week 1)

---

## Pending

### FE-SEC-004-POLISH — Secondary hardening for SEC-004-UI (UI Agent, P2)

**Goal:** Batch P2/P3 items from SEC-004-UI review. SEC-004 atomic pair archived 2026-04-21c — these are ship-anytime polish, no longer blocking.

**Changes:**
1. **`orcid-callback.js:130` orphaned `pevo_signup_orcid_name`** — either remove the `setItem` (if auto-fill abandoned) or add `removeItem` in `signup.js init()` (and optionally read into `fullName`).
2. **`settings.js` handleSetPassword mutation order** — patch `emailStatus` FIRST, flip `passwordSetDone=true` LAST. If the spread throws, form isn't stuck in success state while emailStatus is un-patched.
3. **Collapse overlapping success signals.** Drop `passwordSetDone` — the outer `x-if` on `emailStatus.hasPassword === false` (post-SEC-004-UI field-name fix) already hides the section on success.
4. **`orcid-no-password.spec.js:217-227` — Alpine internals.** Replace `root._x_dataStack[0]` with `Alpine.evaluate(root, 'newPassword = "..."')`.
5. **`orcid-no-password.spec.js:209` — brittle selector.** Add `data-testid="recover-method-orcid"` to the tab button; use that selector.
6. **`pages-settings.test.js` double-guard gap** — test `handleSetPassword` with `passwordSubmitting=true` pre-set; assert no API call.
7. **Strip task-ID refs** (`SEC-004` / `SEC-004-BE` / `SEC-004-UI`) from code comments across signup.js, recover.js, settings.js, api.js. Keep WHY prose.
8. **Placeholder-translation markers for 15 non-English locales** — prefix untranslated strings with `[TODO]` OR add `_todo_keys` array listing untranslated keys. Pick one; document convention in ui/CLAUDE.md.
9. **Resend-button-hide regression test** — `signup.js:150` adds `x-show="!resendSuccess && !orcidToken"` to hide resend on the ORCID branch. The handler body is already guarded (unit-tested in SEC-004-UI follow-up), but the template-level hide has no test surface. Add a small Playwright spec (or extend an existing one) that drives signup to `submitted: true` with `orcidToken` set and asserts `page.getByRole('button', { name: /resend/i })` is not visible. Defense-in-depth for the ORCID-branch-never-sends-password invariant.

**Non-goals:** Splitting settings.js (separate refactor). DRY password validation (FE-PASSWORD-POLICY-DRY, already landed in commit `a753773`).

**Deliverable:** Move to Review.

---

### PASSWORD-POLICY-HARMONIZE — Cross-cutting FE+BE password-policy harmonization (Backend + UI, P3)

**Surfaced by:** SEC-004-BE review triage (2026-04-21).

**Context:** FE-PASSWORD-POLICY-DRY (commit `a753773`) and BE-PASSWORD-POLICY-DRY (archived 2026-04-21c) extracted shared helpers in each stack independently. Both currently encode an identical `length >= 10 && /[a-z]/ && /[A-Z]/ && /[0-9]/` rule, but they will drift unless harmonized explicitly.

**Goal:** Now that both single-stack extractions have landed, harmonize so FE and BE cannot diverge silently:
1. Document the canonical policy in `agents/docs/api-contracts/auth.md` with explicit pointer to both helpers (already partially done — `auth.md:60` and `:382` cite the helper; `settings.md:93` does too).
2. Add `// Keep in sync with frontend/src/password-policy.js` pointer (and vice versa) in both helpers, OR centralize via a JSON schema that both consume.
3. Add a CI check (grep or type-level) that fails when only one side changes.

**Non-goals:** Changing the policy itself. Adding zxcvbn or other strength tools.

**Status:** Both prerequisite helpers landed. No longer blocked.

**Deliverable:** A future unilateral policy change on one side breaks CI, not production.

---

### BE-ACCRED-TEST-MOCK-POLISH — Test-mock hygiene for accreditations route (Backend Agent, P3)

**Surfaced by:** BE-ACCRED-TX-ID-PARITY + BE-ACCRED-REVOKE-TEST archive review (2026-04-21c). All 4 are test-mock hygiene that would surface as visible test failure under refactor — not production risk — but worth a sweep before the next accreditations.ts refactor.

**Changes:**
1. **`backend/tests/routes/accreditations-revoke.test.ts:44`** — `hafCache.clear()` in `beforeEach`. Currently relies on a synthetic-username cache miss; safe today (60s TTL, fresh string), but a sibling test injecting the same username would see stale data.
2. **`backend/tests/routes/accreditations-revoke.test.ts:47`** — multi-signal mock SQL detection. Currently `sql.includes("'action' IN ('accredit', 'revoke')")` couples to a specific quoting/whitespace shape. Mirror the SEC-003-BE round-2 pattern: `sql.includes('FROM customjsonops') && sql.includes("'action' IN ('accredit', 'revoke')")` (or whichever two signals survive the most refactors). A whitespace/quoting change in `accreditations.ts:108-118` currently silently falls into the `rows: []` branch, turning the assertion green for the wrong reason.
3. **`backend/tests/routes/accreditations-revoke.test.ts:61`** — comment edit. The `event_id: null` fixture comment claims it "surfaces regression that leaks event_id on the revoke branch." The revoke branch has no projection path that reads event_id, so the null is defensive signaling, not active coverage. Tighten the comment to match.
4. **`backend/src/routes/accreditations.ts:141`** — change `payload.orcid || null` → `payload.orcid ?? null`. One line above the `?? null` fix from BE-ACCRED-TX-ID-PARITY round-2 finding #10. Operator precision; no behavior change today (HAF JSON values are non-empty strings or absent), but consistent with the immediately-following line.

**Non-goals:** Extracting a `withCleanCache()` test helper. Refactoring the accreditations.ts CTE shape.

**Deliverable:** Move to Review.

---

### SEC-LOGIN-UNKNOWN-USER-TIMING — Close the unknown-account timing oracle on /api/auth/login (Backend Agent, P2)

**Surfaced by:** SEC-004-BE round-2 archive review (2026-04-21c).

**Context:** SEC-004-BE round-2 added a `SENTINEL_ARGON2_HASH_PROMISE`-based timing-equalization burn on the `NO_PASSWORD_SET` (null-hash) branch of `POST /api/auth/login`, closing the `~1ms vs ~100ms` oracle that distinguished ORCID-only accounts from password-loginable accounts. The sibling **unknown-account** branch at `backend/src/routes/auth.ts:~388` returns `401 UNAUTHORIZED` *without any argon2 work*, leaving a separate timing oracle: an unauthenticated attacker can enumerate which usernames/emails have accounts on the platform (existing-account → ~100ms argon2.verify path; non-existing-account → ~1ms early return).

Same enumeration class the round-2 fix addressed; closing only half is asymmetric and provides a false sense of completeness.

**Fix:**
1. On the unknown-account branch in `/login`, burn `await argon2.verify(await SENTINEL_ARGON2_HASH_PROMISE, password).catch(() => {})` before returning 401. Same shape as the null-hash branch.
2. Add a wall-time test to `auth.test.ts` (or `recover.test.ts` if that's where the sibling timing test lives) asserting the unknown-account 401 path takes ≥50ms (loose CI-stability bound matching the existing null-hash timing assertion).
3. Audit other `/api/auth/*` early returns for the same class — `/recover`'s "no active account with that username" path at `auth.ts:~712`, the lockout path, etc. Burn sentinel where they leak existence vs. non-existence by timing. This may grow the fix to 2-3 sites.

**Non-goals:** Closing the status-code oracle (401 stays distinct). Adding rate-limit-based detection. Extracting `burnSentinel()` helper unless 3+ call sites land.

**Deliverable:** Move to Review. Atomic with no other task.

---

### SEC-002-TOCTOU-LOCK — SETNX lock to close same-tick TOCTOU on ORCID binding (Backend Agent, P2)

**Surfaced by:** SEC-002-HARDENING archive review (2026-04-21c, round-2).

**Context:** SEC-002-HARDENING Item 5 added a `${appTag}:orcid_binding:${orcid_id}` Redis cache (EX 120s, value=username) narrowing the HAF-lag TOCTOU window where two concurrent binds for the same `orcid_id` could both pass the 409 guard before either's `accredit` op was indexed by HAF. The cache is consulted on read in `findAccreditedAccountWithOrcid` and short-circuits with 409 when value mismatches the candidate username.

**Remaining race:** the cache is written AFTER `broadcast.json` returns. Two requests entering `findAccreditedAccountWithOrcid` within the same event-loop tick both see empty cache + empty HAF, both broadcast to Hive, both write cache with their respective usernames. The 409 guard never fires for either. Same-tick concurrency is the narrow window — but it's exploitable (~0.1-1s broadcast time, attacker submits two requests concurrently from different sessions).

**Fix:** SETNX lock keyed on `${appTag}:orcid_binding_lock:${orcid_id}` claimed atomically BEFORE broadcast.

1. In `handleAccredit` and `handleLink`, immediately after the empty-binding check passes, attempt:
   ```ts
   const lockKey = `${config.appTag}:orcid_binding_lock:${orcidId}`;
   const acquired = await redis.set(lockKey, username, { NX: true, EX: 10 });
   if (acquired !== 'OK') {
     return sendError(res, 409, 'ORCID_ALREADY_LINKED', 'This ORCID is currently being linked by another request');
   }
   ```
2. After successful broadcast + cache write, `redis.del(lockKey)` (don't leave the 10s lock holding for the full TTL).
3. On error after lock acquisition, also `redis.del(lockKey)` so retries succeed.
4. **Outage fallback:** if `redis.set` throws (Redis unavailable), fall through to current cache-less HAF-only path. Accept the narrow race window in degraded mode rather than failing closed (which would block all binding when Redis blips).

**Tests:**
1. Two concurrent requests for the same `orcid_id` (different usernames) → exactly one succeeds with 200 + broadcast + cache write; the other gets 409 ORCID_ALREADY_LINKED.
2. Lock-holder crash mid-broadcast (simulate by acquiring but never deleting) → second request after EX=10s succeeds.
3. Redis outage during lock acquisition → falls back to current behavior (one warn log, both requests proceed; this is acceptable degradation).

**Non-goals:** Changing the cache TTL. Adding revoke-side cache invalidation (separate problem; bounded window already accepted). Extending the lock to other binding paths (only `/api/orcid/callback` accredit/link modes have this race today).

**Deliverable:** Move to Review.

---

## Review

### BE-ARGON2-PARAMETER-LOCK — Centralize argon2id options across signup/recover/set-password (Backend Agent, P3)

**Status:** Implemented. New `backend/src/lib/argon2-options.ts` exports `ARGON2_OPTIONS` as a frozen `as const` object with `{ type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 }` — numerically identical to node-argon2 v0.31's current defaults, so no hashing-cost regression, but now explicit and drift-resistant. All 5 `argon2.hash` call sites now consume the constant: `auth.ts:33` (SENTINEL_ARGON2_HASH_PROMISE), `auth.ts:157` (signup), `auth.ts:586` (reset), `auth.ts:760` (recover), `settings.ts:384` (set-password). Inline `{ type: argon2.argon2id }` objects are gone. `argon2.verify` call sites (`auth.ts:293/:403/:415`, `custody.ts:193`, `signup-verify.ts:117`) intentionally unchanged — `verify` reads params from the stored hash's encoded prefix, so routing those through `ARGON2_OPTIONS` would be wrong.

New `backend/tests/lib/argon2-options.test.ts` (5 specs): argon2id variant assertion, OWASP minimum guards (memoryCost ≥ 19456, timeCost ≥ 2, parallelism ≥ 1), and one end-to-end `argon2.hash` + `argon2.verify` roundtrip asserting `$argon2id$`-prefixed output — catches structural typos in `ARGON2_OPTIONS` that TS widening would miss. 5/5 pass.

Full backend vitest suite: **254 pass + 3 skipIf across 38 files, no failures.** Typecheck: clean on all touched files; the two pre-existing `claims.ts` `SERVICE_UNAVAILABLE` type errors are BE-CLAIMS-ERROR-POLISH (separate Review entry), not this task.

**[TODO Architect]:** None. No API contract surface change; no user-facing error message change; `auth.md` doesn't describe argon2 params and doesn't need to.

**Unblocks:** None. Orthogonal to PASSWORD-POLICY-HARMONIZE.

---

### SEC-AUTH-BYPASS — Add accreditation-authority filter to getExistingAccreditation (Backend Agent, URGENT P0)

**Status:** Implemented. `backend/src/routes/orcid.ts` `getExistingAccreditation` now filters by `cj.required_posting_auths ?| $4::text[]` with `config.accreditationAuthorities` as $4, mirroring `findAccreditedAccountWithOrcid`. Two SEC-AUTH-BYPASS tests added in `backend/tests/routes/orcid.test.ts` — self-broadcast fake accredit → 422 + no admin broadcast; authority-signed accredit → 200 + admin broadcast fires. 9/9 orcid tests pass. Full backend vitest suite: 221 pass + 3 skipIf across 34 files.

**Review (CE) findings:** clean on the diff itself for orcid.ts.

**Architect re-review (2026-04-21b) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` surfaced one P1 finding that extends the original task's scope beyond orcid.ts — the same auth-bypass class is still open in a sibling endpoint that the task spec did not name.

1. **P1 — profile.ts parity gap.** `backend/src/routes/profile.ts:29-38` (`getAccreditationFromHaf`) lacks the `cj.required_posting_auths ?| $N::text[]` filter that orcid.ts, accreditations.ts, and accreditation.ts all have. Attacker broadcasts a fake `accredit` custom_json with `id=pevotest`, `{action:"accredit", account:"victim", name:"...", institution:"...", ...}` signed with their own posting key. HAF indexes it. `ORDER BY cj.block_num DESC LIMIT 1` picks the attacker's row over any legitimate accreditation. `/api/profile/victim` then renders attacker-chosen `name`, `institution`, `field`, `method`, `orcid`, `tx_id`. Not a privilege escalation (trust set is computed separately via `getAccreditedSet`) but a visible metadata defacement of any profile. Fix: add the authority filter mirroring the shape at `accreditations.ts:113`. Bind `config.accreditationAuthorities` as a new positional param. One-line SQL addition + one-line param binding. Also flip `|| null` → `?? null` at line 53 in the same edit (round-2 finding #10, operator precision — no current behavior change but future-proofs against falsy-non-null regressions).

2. **P3 — Test-file header citation update.** Extend the carve-out justification at `backend/tests/routes/orcid.test.ts:6-15` to cite SEC-AUTH-BYPASS alongside SEC-002-BE + 409 ORCID_ALREADY_LINKED. Concretely: change `"the auth gate (SEC-002-BE) and the 409 ORCID_ALREADY_LINKED check"` to `"the auth gate (SEC-002-BE), the 409 ORCID_ALREADY_LINKED check, and the authority-filter (SEC-AUTH-BYPASS) assertions"`. Round-1 review mistakenly flagged the header as missing; round-2 confirmed it's present. The actual gap is narrower — a citation update only.

3. **Regression test for profile.ts fix.** Add one test asserting that a self-broadcast fake `accredit` op (signed by a non-authority key) is filtered out of `GET /api/profile/:username`. Assertion: response shows `is_accredited: false` with `accreditation: null` (or the true authority-signed metadata if one exists). Mocked-pool acceptable per the CLAUDE.md carve-out; add a justification header to the new or extended test file documenting why real-HAF seeding is impractical for this scenario.

**Dismissed from round-2 findings:** empty `accreditationAuthorities` config (loader guarantees non-empty); active-auth-signed accredit op (authorities broadcast with posting keys across 3 sibling queries — not a reachable scenario).

**[TODO Architect after fixes land]:** No contract shape change required on `profiles.md` — the fix filters rows but does not add or rename response fields. Confirm the test-file header is current once the citation update lands.

**Path to archive:** (1) Backend agent applies findings #1, #8 test-header citation, #10-profile-half, plus the new regression test on profile.ts. (2) Architect re-reviews with `/ce-code-review` once. (3) Archive.

**Backend re-review signal (2026-04-21, working tree, uncommitted):** Fixes applied, ready for architect re-review.
- Finding #1 (P1 profile.ts parity): `backend/src/routes/profile.ts` `getAccreditationFromHaf` now filters `cj.required_posting_auths ?| $4::text[]` with `config.accreditationAuthorities` as $4. `|| null` → `?? null` at `profile.ts:53` and at `accreditations.ts:143` (shared edit with BE-ACCRED-TX-ID-PARITY finding #10).
- Finding #2 (P3 test-header citation): `backend/tests/routes/orcid.test.ts:6-15` header now cites SEC-AUTH-BYPASS alongside SEC-002-BE + 409 ORCID_ALREADY_LINKED.
- Finding #3 (regression test): `backend/tests/routes/profile-auth-bypass.test.ts` (new, mocked-pool carve-out with justification header). 2 specs: self-broadcast fake accredit → `is_accredited:false` + assertion that authority filter SQL + params[3] are applied; authority-signed accredit → `is_accredited:true` + payload shape.

**Architect re-review (2026-04-21, round-3) — HELD PENDING FIXES:**

Round-3 `/ce-code-review` (7 reviewers: correctness, security, testing, maintainability, project-standards, kieran-typescript, ce-agent-native + ce-learnings-researcher). Correctness and security returned clean — the auth-bypass class is closed, the filter is syntactically identical to the 4 sibling sites (accreditations.ts:112, orcid.ts:479/500/526), and the fix survives every bypass scenario examined. Two P2 test-hardening findings + one cross-reviewer-boosted P3 branch-coverage gap must land before archive.

1. **P2 — Mutation-kill gap on the load-bearing SQL assertion** (`backend/tests/routes/profile-auth-bypass.test.ts:77-95` + analogous spots in the new SEC-AUTH-BYPASS specs in `orcid.test.ts`). The `expect(sql).toContain('required_posting_auths ?| $4::text[]')` assertion lives INSIDE the `if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1"))` guard of `hafQueryMock.mockImplementation`. If a future SQL refactor changes the column selection or query shape such that the `if` condition no longer fires, the mock falls through to `return { rows: [] }`, the outer assertions (`is_accredited:false`, `accreditation:null`) still pass, and the test gives NO signal that the load-bearing assertion never ran. Fix: add `expect(hafQueryMock).toHaveBeenCalled()` after each `request(app)` call in both specs (2 sites in profile-auth-bypass.test.ts, 2 sites in orcid.test.ts new SEC-AUTH-BYPASS specs). That proves the guarded branch fired at least once. ~4 lines total across both files.

2. **P3 (cross-reviewer boosted to must-fix) — Revoke-branch untested in `getAccreditationFromHaf`** (`backend/src/routes/profile.ts:51`). Four reviewers converged: `if (payload.action === 'revoke') return null` is reachable but has zero test coverage. The two new specs cover zero-rows (unaccredited) and accredit-row (accredited) but not the revoke-row path. Parallel to what `accreditations-revoke.test.ts` provides for the sibling endpoint — the symmetric coverage should exist here. Fix: add a third spec in `profile-auth-bypass.test.ts` injecting `{action:'revoke', ...}` as the latest row, assert `is_accredited:false` + `accreditation:null`. ~15 lines. Batch with the #1 edit since both live in the same file.

**Dismissed (architect review — not blocking):**
- **Clause (c) of the root CLAUDE.md mocking carve-out ("real-HAF variant exists or follow-up filed")** (project-standards PS-001/PS-002, P2 at 0.80): explicitly waived in this review. The spirit of clause (c) is to prevent mocks from being the only coverage so a mocked-pass/real-fail can hide bugs. Here the identical `required_posting_auths ?| $4::text[]` filter pattern IS tested against real HAF at 4 sibling sites (accreditations.ts, orcid.ts × 3) — those prove Postgres jsonb `?|` semantics against real HAF + real `config.accreditationAuthorities` wiring. The SEC-AUTH-BYPASS-specific assertion (self-broadcast signed by non-authority) is infeasible at real HAF: would require broadcasting a live pevotest `custom_json` from a throwaway account per test run, which is paperwork theater rather than coverage value. Waiving clause (c) here with this reasoning; not filing a follow-up.
- **Task-ID reference "See SEC-AUTH-BYPASS." in profile.ts:32 comment** (MAINT-002, P3 at 0.75): sibling orcid.ts:520 does the same thing; project-standards reviewer dismissed since no standard explicitly prohibits task-ID references in code comments. Treating as intentional convention (CVE-tag-style) pending a future doc-policy decision.
- **Mixed `|| null` / `?? null` in same return literal** (MAINT-004, P3 at 0.72): sibling accreditations.ts:141 has the same pattern — not new drift introduced by this fix.
- **4-site CTE authority-filter duplication** (MAINT-001, P3 at 0.65): extraction candidate, filed as follow-up consideration, not blocking.
- **hafCache not cleared in beforeEach** (T-03, P3 at 0.82): latent trap, unique victim names prevent current bleed; fix belongs in a broader test-infrastructure cleanup.
- **Redis-mock block duplication across 3 test files** (MAINT-003, P3 at 0.70): test-helper refactor candidate, not blocking.
- **Positive-path missing call-count check** (T-04, P3 at 0.80): subsumed by finding #1's `expect(hafQueryMock).toHaveBeenCalled()` fix which covers positive path too.
- **`$4` param-index literal fragility** (T-02, P3 at 0.85): `expect(params[3]).toEqual(...)` already provides the redundant defense; adding `expect(params).toHaveLength(4)` is marginal.
- **`params[3]` unknown IDE narrowing** (KT-001, P3 at 0.62): typing is correct, `unknown[]` is the right mock signature, no defect.
- **Cache-TTL race on authority rotation** (security RR-001, informational): design-level time-window issue identical to sibling accreditations.ts; not exploitable, not new.

**Past solutions relevant (ce-learnings-researcher):** `agents/docs/solutions/conventions/test-config-mock-distinct-role-accounts-2026-04-21.md` (SEC-003-BE B5 origin) and `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md` (uses `??` deliberately for the same precision reason as this fix). Both consulted, both confirmed no drift from this change.

**Path to archive:** (1) Backend agent applies findings #1 (4-site `expect(hafQueryMock).toHaveBeenCalled()` addition) + #2 (revoke-branch spec in profile-auth-bypass.test.ts). (2) Architect re-reviews round-4 with `/ce-code-review`. (3) Archive atomically with the uncommitted `accreditation.md` / `auth.md` / `papers.md` doc changes.

---

### SEC-002-HARDENING — Post-review hardening of /api/orcid (Backend Agent, P2)

**Status:** All 6 items landed at commit **0e4241b** ("harden /api/orcid state consume, envelope, TOCTOU cache, prod warn (SEC-002-HARDENING)"). 14/14 `orcid.test.ts` pass (9 pre-existing SEC-002-BE + 5 new hardening). Full backend vitest 239 pass + 1 skipped; 2 `hafsql.test.ts` ECONNRESETs under concurrency, pass in isolation (infra flap, unrelated to this commit).

- **#1 state-consume inside try/catch** — `backend/src/routes/orcid.ts:185-194`. `redis.del`/`orcidStates.delete` now sits inside the outer try wrapping the token-exchange dispatch; a Redis DEL throw maps to 500 via the existing catch. Did NOT use `redis.getdel` — would break #3's state-not-consumed-on-403 contract.
- **#2 NO_ACCOUNT envelope fix** — `handleLogin` now emits `sendError(res, 404, 'NO_ACCOUNT', '...', { orcid_id })` so the frontend `ApiRequestError` parser receives `orcid_id` under `error.details`. Required adding `details?: Record<string, unknown>` to the `ApiError.error` shape in `backend/src/types/api.ts` and a `details` parameter on `sendError` in `backend/src/response.ts`.
- **#3 state-not-consumed-on-403 contract** — code-side contract enforced by the #1 move (consume fires only when auth passes). See **[TODO Architect post-fix]** below for the orcid.md prose.
- **#4 `orcid-link.spec.js:107-115` test.fixme** — implemented the two-browser-contexts 403 test (`frontend/tests/e2e/orcid-link.spec.js:107-176`); hits the API directly across two `browser.newContext()`s, asserts 403 FORBIDDEN. Falls back to `test.skip` with a concrete citation when ORCID is unconfigured in the test environment.
- **#5 HAF-lag TOCTOU mitigation** — `${config.appTag}:orcid_binding:${orcid_id}` EX 120s/value=username, written after the successful broadcast in both `handleAccredit` and `handleLink`. `findAccreditedAccountWithOrcid` consults Redis first and short-circuits when `value !== candidateUsername`. Redis outage degrades gracefully (falls back to the HAF-only path). NOTE: same-tick concurrent races remain — see SEC-002-TOCTOU-LOCK Pending follow-up.
- **#6 production multi-process startup check** — new `backend/src/startup-checks.ts` `checkOrcidProcessSafety()`, wired from `backend/src/index.ts` post-listen. Fires a loud `logger.warn` 5s after boot under `NODE_ENV=production` when Redis is not ready, calling out single-process-only `orcidStates` fallback as a multi-process/PM2/clustered-deploy breakage risk.

**Architect re-review (2026-04-21c) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` (correctness/security/reliability/testing/maintainability/project-standards/kieran-typescript) on commit `0e4241b` confirmed the 6 landed items work as designed. One P2 finding extends Item 1's promise; remaining items dismissed or split to follow-ups.

1. **P2 — State-read still outside try/catch** (`backend/src/routes/orcid.ts:151`). Item 1 wrapped the Redis DEL inside the try/catch around the token-exchange dispatch, but the upstream `redis.get(stateKey)` at line 151 and `authenticateRequest` at line 177 remain outside. A transient Redis flap on the GET (or auth dispatch) escapes as an unhandled rejection — the exact failure mode Item 1 promised to close. Fix: widen the outer try to encompass the GET + the auth-check block, mapping any throw to 500 INTERNAL_ERROR with the same message shape the DEL-throw path now produces. Single-file edit in `orcid.ts`. Add one test: `redis.get` mocked to throw → 500 INTERNAL_ERROR with `state` NOT consumed (matches the state-not-consumed-on-403 contract for symmetry on infrastructure errors).

**Split to Pending follow-up: SEC-002-TOCTOU-LOCK (P2).** Round-2 also confirmed Item 5's narrowing of the HAF-lag TOCTOU window does NOT close the same-event-loop-tick race (cache write is post-broadcast, two concurrent same-orcid-id requests both broadcast). Fix is bigger surgery (SETNX lock semantics + outage fallback story) than fits in this task's scope; filed as Pending P2 with concrete shape.

**Dismissed from round-2 findings (architect review):**
- **(P3) No revoke-side cache invalidation, false 409 within 120s window if a different user tries to bind a just-freed ORCID:** revokes happen via on-chain `custom_json` (no PEvO endpoint to hook); the right shape is shorter TTL or accept the bounded window. 120s is acceptable for beta — revoke-then-rebind is a rare flow.
- **(P3) `error.details` widening unread by frontend:** grepped `frontend/src/` for top-level `orcid_id` consumers of NO_ACCOUNT — only hit is `orcid-callback.js:118` which reads `err.code === 'NO_ACCOUNT'` and uses a localized message, no field-level read. Move from top-level to `error.details` is end-to-end inert.
- **(P3) `setTimeout(5000)` startup check robustness:** plausible improvement (subscribe to the Redis client's `ready` event instead of fixed timeout) but no real failure motivating the change. Defer to a real incident.
- **(P3) `@ts-expect-error` in test:** cosmetic.

**[TODO Architect post-fix]** — `agents/docs/api-contracts/orcid.md` doc updates from the original status block, deferred to atomic archive once the state-read widening lands. Items 2/3 are stable and won't change shape further:
1. Under `POST /api/orcid/callback`, document the state-not-consumed-on-403 contract: "On a 403 FORBIDDEN response from authenticated modes (caller username does not match the initiator stored at /start), the OAuth `state` parameter is intentionally NOT consumed. The legitimate initiator can retry `/callback` with a valid bearer without being forced back through the ORCID OAuth redirect. State is consumed only after auth passes, or after any success or error on unauthenticated modes."
2. Update the NO_ACCOUNT response example: `orcid_id` now lives under `error.details`, not at the top level. Shape: `{ "status": "error", "error": { "code": "NO_ACCOUNT", "message": "...", "details": { "orcid_id": "0000-..." } } }`.
3. Optional: add a one-line note in `common.md` documenting that `error.details` is the canonical channel for error-context fields (mirrors the generic `ApiError.error` shape change in `backend/src/types/api.ts`).

**Path to archive:** (1) Backend agent applies finding #1 (try/catch widening + one test). (2) Architect re-reviews round-3 with `/ce-code-review`, lands the deferred orcid.md updates, archives.

---

### BE-CLAIMS-ERROR-POLISH — Surface bridge misconfiguration with a distinct 503 (Backend Agent, P3)

**Status:** Landed at commit **1cec6df** ("surface bridge misconfig with 503 (BE-CLAIMS-ERROR-POLISH)"). 16/16 `claims.test.ts` pass (13 pre-existing + 3 new BE-CLAIMS scenarios).

- **claims.ts:194-196** (approve handler): new guard `if (paperAuthor === config.hiveBridgeAccount && !config.pevoBridgePostingKey) return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Bridge posting key not configured')`, placed immediately before the bridge-branch auth check so operators see a dedicated 503 instead of the misleading "Only the post author can approve claims on native papers" fall-through.
- **claims.ts:290-292** (revoke handler): same guard, placed **after** basic authorization (isPostAuthor/isClaimer/isAdmin) so unrelated callers still see 403 FORBIDDEN first; the 503 fires only for authorized callers on bridge papers with no posting key. Spec line numbers (~190/~277) drifted to 194/290 after the SEC-003-BE round-2 `active_accreditations` JOIN + chain-visible-actor comment.
- **`backend/tests/routes/claims.test.ts`** — new `describe('BE-CLAIMS-ERROR-POLISH — bridge misconfig surfaces as 503')` block (3 scenarios: approve 503, revoke 503 from admin, no `broadcastJson` in either case). Per-test save/restore of `config.pevoBridgePostingKey` via `afterEach`.

No contract change required (shape is a generic `SERVICE_UNAVAILABLE` 503, fits the existing envelope).

**Follow-up fix (2026-04-21, commit `52419c5`):** `SERVICE_UNAVAILABLE` added to the `ErrorCode` union in `backend/src/types/api.ts`. The 1cec6df landing introduced the new code at two call sites (`claims.ts:195`, `claims.ts:291`) without extending the type union, which broke `npx tsc` in the Docker backend image build. Typecheck now clean.

**Architect re-review (2026-04-21c) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` (correctness/security/testing/api-contract/maintainability) on commit `1cec6df` confirmed the 503 guards work and tests are sound. One P2 cross-file inconsistency must close before archive.

1. **P2 — `bridge.ts` returns 500 INTERNAL_ERROR for the same misconfig** (`backend/src/routes/bridge.ts:158, :278`). Two bridge endpoints (registration + update) already returned 500 INTERNAL_ERROR with the identical `"Bridge posting key not configured"` message before this task. The new claims guards in commit `1cec6df` return 503 SERVICE_UNAVAILABLE — the more correct code per RFC 9110 ("deployment cannot broadcast on behalf of the bridge account right now" is service-availability, not internal-error). Result: same root cause, two codes. Fix: backport `bridge.ts` (both sites) to 503 SERVICE_UNAVAILABLE with the identical message + extract a small `assertBridgeKeyConfigured(res, paperAuthor)` helper (one return-true-if-configured, one return-false-after-sendError shape) so the four call sites (2 in bridge.ts + 2 in claims.ts) all source from one constant. Folds the round-2 P3 (helper-extraction-on-byte-identical-guards) in for free. Add one `bridge.test.ts` scenario per converted site asserting the 503 + identical error message.

**Dismissed from round-2 findings (architect review):**
- **(P3) `afterEach` save/restore ceremonial:** vitest file-level serial execution + per-test afterEach is safe; no race risk with sibling SEC-003-BE tests in the same file. The `(config as { ... })` cast matches the existing pattern. Discretionary refactor at most.
- **Pre-auth info leak on the approve guard (advisory):** dismissed. `verifyHiveSignature` runs before the guard, so unauthenticated callers never reach it. Authenticated-but-unrelated callers learn only that the paper author equals the bridge account — already public on-chain.

**Path to archive:** (1) Backend agent applies finding #1 (bridge.ts → 503 + helper extraction + 2 bridge.test.ts scenarios). (2) Architect re-reviews round-3 with `/ce-code-review`, archives.

---

### FE-E2E-SPEC-TRACE-OFF (UI Agent, URGENT P0)

**Status:** Landed at commit `3d59773`. 9 specs opted out of trace retention (`test.use({trace:'off', video:'off', screenshot:'off'})`); `scanTracesForSecrets` regex widened with JWT + SESSION_SECRET literal + compressed WIF + BIP39 mnemonic patterns.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-TRACE-SCAN-HARDEN (UI Agent, P1)

**Status:** Landed at commit `ca48a23`. `scanTracesForSecrets` hardened: ENOENT vs per-file error classification, scan-then-cleanup-always-runs ordering, category labels (no secret bytes in CI logs), explicit <16-char SESSION_SECRET warning. 14 new unit tests via `spawnSync` mock + `cleanupIpfsPins` export. Follow-up hermetic fix at `b2a2140` purges stray trace.zip before each test.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-E2E-FIXTURE-CORRECTNESS (UI Agent, P1)

**Status:** Landed at commit `0c01d4e`. 8 fixes: hostname-based localhost guard, strict `_test` dbName regex, `parseEnvFile` dedup (no more inline-comment divergence), `E2E_SESSION_SECRET` rename (no Docker-env leak), `mintSessionJwt` unit test (4 specs), `pickAccreditedResearcherOnce` try/catch, visible redis error warn, spec-level bugs (null-body check, picker-throw-not-truthy). Hermetic test fix for `fileURLToPath` path divergence at `a20a92e`.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-E2E-RETRY-SUFFIX (UI Agent, P1)

**Status:** Landed at commit `45946e2`. `RUN_SUFFIX` now computed per-test-body with `testInfo.retry` suffix across 5 specs (`email-signup`, `seed-phrase`, `password-recovery` single-test; `login-email`, `settings` use `beforeAll`-scoped describe pattern to preserve single-row seeding). Retry attempts surface original root cause instead of 409 DUPLICATE.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-ORCID-CALLBACK-FIXES (UI Agent, P1)

**Status:** Landed at commit `0951fef`. `_saveSession` 6-arg misuse fixed in `orcid-callback.js:148` AND `login.js:152` (same bug); `auth.expiresAt = data.expires_at` set before `_saveSession()`. `pevo_orcid_mode` removeItem moved into success handler of `completeOrcid`. New tests in `pages-orcid-callback.test.js` + `pages-login.test.js`. **Flagged follow-up:** same `_saveSession` 6-arg pattern still exists at `signup-verify.js:412/457` and `settings.js:550` — candidate for a `FE-SAVESESSION-API-MISUSE-SWEEP` task.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-AUTH-POST-AWAIT-GUARD (UI Agent, P1)

**Status:** Landed at commit `10ada81`. Post-await re-check `if (!this.username || !this.isConnected) return;` added between the `fetchAccreditationStatus` await and the write block in `_checkAccreditation`. Closes the disconnect race orthogonal to FE-AUTH-ACCRED-POLL-GUARD's pre-fetch guard. Race-closing test holds the fetch open, calls `disconnect()`, asserts state not mutated.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-AUTH-TEST-HARDEN (UI Agent, P3)

**Status:** Landed at commit `08b1428`. Mutation-kill assertions added to `auth.test.js`: rejected-fetch test seeds + asserts state NOT mutated; happy-path asserts `localStorage.setItem('pevo_session', ...)`; new `accRes.data === null` branch test. Removed redundant `mockClear` calls. Stripped Playwright reference + "Log but do not reject" WHAT-comment from `auth.js`.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-PASSWORD-POLICY-DRY (UI Agent, P3)

**Status:** Landed at commit `a753773`. New `frontend/src/password-policy.js` exports `MIN_PASSWORD_LENGTH = 10` + `isPasswordValid(pw)`. 4 consumers (`signup.js`, `recover.js`, `settings.js`, `reset-password.js`) rewritten to wrap the shared helper. 8 new tests in `password-policy.test.js`. Unblocks `PASSWORD-POLICY-HARMONIZE` (cross-cutting FE+BE) which is still Pending.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-KEYCHAIN-API-MISUSE (UI Agent, P1)

**Status:** Landed at commit `c4e27f1`. `requestAddAccountAuthority` → `requestImportKey(username, wif, cb)` in `settings.js` `executeUpgrade()`. WIF derived via `dhive.PrivateKey.fromSeed(newKeys.posting).toString()` (reuses existing dynamic `dhive` import). E2E stub tightened: asserts second arg matches WIF regex `/^5[HJK][1-9A-HJ-NP-Za-km-z]{49}$/`, rejects raw hex. Unit regression test asserts `settings.js` no longer contains `requestAddAccountAuthority(`. **Grep result:** no other production callers. **Product decision outstanding:** posting-only (current) vs active/owner/memo too — implementer recommendation is posting-only (see commit report).

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-UPGRADE-CREDENTIAL-WIPE (UI Agent, P1)

**Status:** Landed at commit `dfece3e`. New `_clearSensitiveUpgradeState()` helper zeros `oldSeedPhrase`, `newSeedPhrase`, `newSeedWords`, `confirmInputs`, `upgradePassword`. Called on both success (before `upgradePhase = 'done'`) and error paths. `resetUpgrade()` refactored to use the same helper. Unit + E2E tests assert all 5 sensitive fields are empty post-upgrade. Sensitive-state audit: no other holders on the page need the wipe (handleSetPassword already zeroes on both paths).

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-UPGRADE-KEY-WRAPPER-ADOPT (UI Agent)

**Status:** Landed at commit `276ed8f`. `settings.js` now imports `generateMnemonic`/`validateMnemonic`/`mnemonicToSeedSync` from `../hive-keys.js` (no raw `@scure/bip39` imports, no manual `wordlist` threading). `custody-upgrade.spec.js` signature regex tightened to `/^[0-9a-fA-F]{130}$/`; pubkeys cross-checked against independently-derived values via `deriveAllKeys`; old/new seeds now distinct so broadcast exercises real rotation; `newSeedPhrase` read gated on `I've written it down` button. `@hiveio/dhive` + `@scure/bip39` exact-pinned in `package.json`.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-TOTALPAGES-INFINITY-GUARD (UI Agent, P1)

**Status:** Landed at commit `74f9d93`. Extracted `totalPagesFromMeta(meta)` to new `frontend/src/lib/pagination.js` guarding against `Math.ceil(n/0) === Infinity` (Infinity is truthy, `|| 1` didn't fire). Three consumers (`paper-feed.js`, `researchers.js`, `search.js`) swap to the helper. Note: `home.js` was refactored into `paper-feed.js` component earlier (commit `665011b`), so only 3 sites not 4 as task spec said. 5 lib tests + 1 consumer test per feed file.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-URL-SYNC-UTIL-EXTRACT (UI Agent, P2)

**Status:** Landed at commit `ff22ce4`. New `frontend/src/lib/url-sync.js` exports pure `localeStrippedPath(pathname)`. Handles `/en/papers` → `/papers`, `/fr/papers/` → `/papers` (trailing slash drop), `/en` → `/`, `/research-something` unchanged. Three consumers swap. `feedOwnsUrl` → `pageOwnsUrl` rename in `paper-feed.js`. Missing inner popstate guard added to `paper-feed.js`; `pageOwnsUrl()` early-out added to `researchers._syncFromUrl()`. 8 lib tests. `search._syncFromUrl` left alone per task scope.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-URL-PAGE-TEST-GAPS (UI Agent, P2)

**Status:** Landed at commit `1400df2`. Popstate coverage parity across 3 feed test files: registration-skipped-off-page, handler-inert-on-drift, `destroy()` removes listener, in-path happy path. `loadDisciplines` rejection resilience tests added to paper-feed + search. `_pushUrl` with `currentPage=1` + no filters → bare path (no query string) tests added to all 3. Causal-chain assertions (`expect(comp.currentPage).toBe(1)`) added to catch-block pushUrl tests. 15 new tests total.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-LOADDISCIPLINES-OBSERVABILITY (UI Agent, P2)

**Status:** Landed at commit `7abb7d1`. `paper-feed.js` + `search.js`: added `disciplinesLoadFailed: false` state; `init()` `.catch(() => {})` replaced with `.catch((err) => { console.warn('[loadDisciplines]', err); this.disciplinesLoadFailed = true; })`. `:data-disciplines-status="disciplinesLoadFailed ? 'failed' : 'ok'"` bound on the discipline `<select>`. Playwright agents can now assert failure. `researchers.js` verified to have no disciplines dropdown — no changes there.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-DISCIPLINE-CASE-NORMALIZE (UI Agent, P2)

**Status:** Landed at commit `4dfe05e`. Lowercase-canonical discipline value across `paper-feed.js` + `search.js`: `_syncFromUrl()` lowercases incoming param; `_pushUrl()` lowercases before writing; `loadDisciplines()` lowercases API-returned names. Display stays titlecased via existing Tailwind `class="capitalize"` on options. 12 new tests. Existing URLs like `?discipline=Physics` still resolve (API is case-insensitive). `researchers.js` has no disciplines — verified.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

### FE-SEARCH-QUERY-URL-HYGIENE (UI Agent, P3)

**Status:** Landed at commit `7652f2d`. Three P3 cleanup items. (1) `doSearch` entry trims `q`, normalizes `this.query` so input/URL/API all see the same trimmed form. (2) Filter-change policy decided: keep submit-gated, intentional asymmetry with paper-feed (user-initiated vs passive feed) — comment added inline near filter row. (3) `/papers` Alpine scope renamed `homePage` → `papersPage` (new `initPapersPage` + registered in `index.js`); home.js unchanged. New trim-roundtrip unit test.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

---

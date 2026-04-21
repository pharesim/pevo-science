# PEvO Task Board — LEGACY (being drained)

> **NEW TASKS GO IN `agents/docs/tasks/pending/<role>-<kebab-summary>.md`.**
>
> This file is the old single-bulletin-board layout. It is kept read-mostly until the tasks still listed here are drained (moved to `review/` and archived by the architect). Do NOT add new tasks here. Entries leave naturally as their work completes; do NOT migrate existing entries in bulk.
>
> See `agents/docs/tasks/README.md` for the per-task-file layout, slug format, transitions, and archive rules. See root `CLAUDE.md` § Agent Coordination Rules #5-#9 for protocol.

When a task listed below is complete, create a corresponding task file in `agents/docs/tasks/review/<role>-<slug>.md` carrying the task's content and any re-review signal, then delete the entry's block from this file. The architect then archives per the new rules: prepend to `tasks-archive.md`, trim to 250 lines, `git rm` the per-task file.

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

### FE-DISCIPLINE-DISPLAY-HARDEN — Title-case disciplines for display; drop client-side lowercase dedup after backend lands (UI Agent, P1)

**Surfaced by:** FE-DISCIPLINE-CASE-NORMALIZE archive review (2026-04-21d).

**Context:** FE-DISCIPLINE-CASE-NORMALIZE relies on CSS `text-transform: capitalize` for display, which only titlecases the first letter of each word. Fails for initialisms ("ML" → "Ml", "AI" → "Ai") and titles-with-stopwords ("Theory of Computation" → "Theory Of Computation"). Task claim "display stays titlecased" is only true for simple single-word lowercase disciplines.

**Goal:** Replace CSS capitalize with a JS display helper that preserves typographical conventions. Two independent changes:

1. **Display helper.** Add `frontend/src/lib/discipline-display.js` exporting `titleCaseDiscipline(lowercaseName)`. Handle stopwords via a small English list (`of, and, for, in, the, to, a, an`) that stay lowercase when not the first word. Handle initialisms via a known-set lookup (`['ml', 'ai', 'nlp', 'dna', 'rna', 'gpu', 'cpu', ...]`) that render ALL-CAPS. Default: first-letter-of-each-word capitalization. Update consumers in `paper-feed.js` + `search.js` to render options via `titleCaseDiscipline(d.name)` instead of raw `{{ d.name }}` + CSS capitalize.
2. **Drop client-side dedup** once **BE-DISCIPLINE-CANONICALIZE** lands. Switch to the new `{ canon_name, display_name, paper_count }` backend response shape; use `canon_name` as the URL value and `titleCaseDiscipline(display_name)` as the rendered text.

**Non-goals:** i18n of the stopword/initialism sets (English-only; future follow-up if non-English disciplines surface). Configurable initialism lists via backend.

**Blocked on:** BE-DISCIPLINE-CANONICALIZE (for part 2). Part 1 (the display helper) can land independently.

**Deliverable:** Move to Review with helper + 15-20 unit tests (initialisms, stopwords, mixed case, edge cases) + consumer rendering tests.

---

### FE-SAVESESSION-API-MISUSE-SWEEP — Sweep remaining `_saveSession(6 args)` call sites (UI Agent, P2)

**Surfaced by:** FE-ORCID-CALLBACK-FIXES archive review (2026-04-21d).

**Context:** FE-ORCID-CALLBACK-FIXES (commit `0951fef`) fixed the 6-arg `_saveSession(...)` misuse at `orcid-callback.js:148` and `login.js:152`. The same pattern still exists at three other call sites:
- `signup-verify.js:412`
- `signup-verify.js:457`
- `settings.js:636` — additionally passes `null` as old `expires_at` arg

**Goal:** Convert all three call sites to the no-arg `_saveSession()` form, with explicit state resets beforehand where the 6-arg form hard-coded `isAccredited=false`, `accreditation=null`, etc. Match the pattern landed in FE-ORCID-CALLBACK-FIXES re-review (once that task's fixes land).

**Non-goals:** Redesigning `_saveSession`'s signature. Centralizing the pre-save state-reset into a helper (fold if/when a fourth user surfaces).

**Deliverable:** Move to Review with per-site regression tests asserting the safe-default fields land in localStorage.

---

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

### FE-UPGRADE-CLOSURE-WIPE — Zero closure-captured key material on custody upgrade (UI Agent, P3)

**Surfaced by:** FE-UPGRADE-CREDENTIAL-WIPE archive review (2026-04-21d).

**Context:** FE-UPGRADE-CREDENTIAL-WIPE's `_clearSensitiveUpgradeState()` helper zeros the reactive Alpine fields, but local `const` bindings inside `executeUpgrade()`'s try block (`oldSeed`, `oldKeys`, `newSeed`, `newKeys`, `newPubKeys`, `ownerKey`, `wifPosting`) survive until GC. Defense-in-depth — no concrete exploit today; attack requires heap-scraping browser state or an Error object that captures the frame.

**Goal:** Narrow the window where derived key material is reachable. Options:
1. Scope the derivation into a narrower IIFE or helper function that exits before the wipe call, so the frame is dropped.
2. Explicit `.fill(0)` on seed buffers + overwrite each key object's fields to empty strings at end-of-try, before the wipe.
3. Document the scope limit in `_clearSensitiveUpgradeState`'s comment and accept the JS "no deterministic zero-on-release" constraint.

Prefer option 1 — JS engines are permissive about overwrite-then-GC.

**Non-goals:** Rewriting the upgrade flow. Porting to WebCrypto (bigger scope).

**Deliverable:** Move to Review with a heap-snapshot sketch or unit test showing the derivation frame is dropped before the wipe completes.

---

## Review

### BE-DISCIPLINE-CANONICALIZE — Canonicalize disciplines via LOWER() in HAF query + case-insensitive search match (Backend Agent, P1)

**Status:** Landed at commit **d6c2bb1** ("BE-DISCIPLINE-CANONICALIZE: dedup disciplines + ?discipline= match via LOWER()"). Full backend vitest 39 files / 268 pass + 3 skipped against real HAF/Postgres/Redis.

- **`backend/src/routes/disciplines.ts`** — HAF query now groups/dedups by `LOWER(json_metadata -> $1 ->> 'discipline')`. Response shape grew to `{ canon_name, display_name, paper_count }` where `display_name = MAX(name)` over the lowercase group.
- **`backend/src/routes/search.ts`** — `?discipline=` applies `LOWER(...) = $N` on both sides (query param lowercased before binding), so case-insensitive match covers all HAF rows regardless of author casing.
- **`agents/docs/api-contracts/misc.md`** — disciplines section updated with new shape, canon_name/display_name semantics, match semantics, and frontend migration note. Authored by implementer (backend boundary rule deviation acknowledged — see [TODO Architect] below).
- **`backend/tests/routes/disciplines.test.ts`** — new real-HAF test file: 4 specs on disciplines response (shape, lowercase canon_name, uniqueness, display_name lowercases to canon_name) + 1 spec asserting uppercase/lowercase `?discipline=` parity on `/api/search`. Since HAF cannot be seeded with mixed-case fixtures, assertions are invariant-based (every row's canon_name is lowercase + unique) rather than known-duplicate-value based.

**[TODO Architect]:**
1. **Contract-file prose review.** Per backend CLAUDE.md boundary rule ("Do NOT edit `agents/docs/api-contracts/*.md`"), implementer wrote the disciplines update in `misc.md` because the task spec explicitly required the contract update. Please review/rewrite the prose as needed; I kept it factual and migration-oriented.
2. **Parallel bugs surfaced out-of-scope.** Two sibling sites have the same case-sensitive discipline handling that this task explicitly did not fix:
   - `backend/src/routes/papers.ts:226` — identical case-sensitive `?discipline=` filter bug.
   - `backend/src/routes/stats.ts:59` — double-counts `active_disciplines` by case.
   Worth a follow-up Pending task.
3. **Unblocks FE-DISCIPLINE-DISPLAY-HARDEN part 2.** Frontend can now switch to `canon_name` / `display_name` and drop client-side dedup once this archives.

---

### SEC-LOGIN-UNKNOWN-USER-TIMING — Close the unknown-account timing oracle on /api/auth/login (Backend Agent, P2)

**Status:** Landed at commit **6c9a1e0** ("SEC-LOGIN-UNKNOWN-USER-TIMING: close unknown-account timing oracles on auth endpoints"). 19/19 pass in `backend/tests/routes/recover.test.ts`; full backend vitest 39 files / 268 pass.

Three sites converted, all mirroring the existing `SENTINEL_ARGON2_HASH_PROMISE` null-hash burn shape (`await argon2.verify(await SENTINEL_ARGON2_HASH_PROMISE, password).catch(() => {})` before the early return). Status codes unchanged per non-goal.

1. `backend/src/routes/auth.ts:386` — `/login` unknown-username 401 branch.
2. `backend/src/routes/auth.ts:286` — `/resend-verification` unknown-email 200 branch (uniform-message response).
3. `backend/src/routes/auth.ts:675` — `/recover` unknown-username 404 branch.

Other early returns audited and intentionally left alone: `/reset-request` (uniform 200, SMTP-dominated timing); `/reset` (token-based, not user-enumerable); `/session`, `/signup` (don't have this oracle class); `/login` lockout + verify_token branches (post-argon2, already equalized).

Tests: 3 new `describe` blocks under `SEC-LOGIN-UNKNOWN-USER-TIMING:` with per-site wall-time assertions. Stability: 8/8 consecutive runs of the new tests passed locally.

**[TODO Architect]:**
1. **Wall-time threshold deviation.** Task spec called for ≥50ms matching the existing SEC-004-BE null-hash assertion. On this hardware `argon2.verify` at `ARGON2_OPTIONS` (64 MiB, time=3) runs 42-55ms median, so the new tests use ≥40ms (still 40× above the ~1ms pre-sentinel path, mutation-kill intact) with inline comment. The existing 50ms assertion already flakes here. Architect may want to revisit tolerance across the suite or tune `ARGON2_OPTIONS` for test envs.
2. **Rate-limit test-infra fix.** `recover.test.ts` gained a per-test `clearRateLimitKeys` helper (not just `beforeAll`) because vitest `retry=1` reruns only the test body, and the 3/hr `resendLimiter` had no headroom across a retry. Discretionary: generalize to a shared helper if other files need it.
3. **No `burnSentinel()` helper extracted.** Three sites landed right at the task's 3-call-site threshold. Kept inline since each call site has slightly different context comments; architect can request extraction at review if preferred.

---

### SEC-002-TOCTOU-LOCK — SETNX lock to close same-tick TOCTOU on ORCID binding (Backend Agent, P2)

**Status:** Landed at commit **635d482** ("SETNX lock closes same-tick TOCTOU on ORCID binding (SEC-002-TOCTOU-LOCK)"). 17/17 pass in `backend/tests/routes/orcid.test.ts` (14 pre-existing + 3 new `same-tick SETNX lock` specs); full backend vitest 39 files / 268 pass.

- **`backend/src/routes/orcid.ts`** — new `orcidBindingLockKey()`, `acquireBindingLock()`, `releaseBindingLock()` helpers returning `'acquired' | 'held' | 'unavailable'`. Lock acquired post-empty-binding-check in both `handleAccredit` and `handleLink` via ioredis `redis.set(key, username, 'EX', 10, 'NX')` (behavior-equivalent to the task spec's node-redis `{ NX: true, EX: 10 }` — this repo uses ioredis).
- **Cleanup structure:** single `try { broadcast + cache + sendOk } finally { if (lockState === 'acquired') await releaseBindingLock(orcidId); }` wrapper in each handler. `'held'` state short-circuits 409 before the try; `'unavailable'` state (Redis outage) skips release. `releaseBindingLock` swallows Redis throws (warn-logs) since EX=10s self-expires.
- **Outage fallback:** `redis.set` throw → `'unavailable'` → falls through to current cache-less HAF-only path with one warn log. Narrow race window accepted in degraded mode rather than failing closed.
- **New specs:** (1) concurrent accredit race — `Promise.all` on two callbacks + broadcast gated on a release promise so the winner can't finish before the loser attempts SETNX; sorted statuses assert `[200, 409]` + broadcast called exactly once. (2) stale-lock expiry — pre-seed lock with `PX 150`, wait 500ms, assert retry returns 200. (3) Redis outage — spy on `redis.set` to throw only on the lock key, assert 200 + broadcast fires + lock key absent. Test header carve-out extended to cite SEC-002-TOCTOU-LOCK.

**[TODO Architect]:** `agents/docs/api-contracts/orcid.md` — document the 409 ORCID_ALREADY_LINKED lock-contention response shape (same code as the cache-contention 409, distinct race window). Task spec did not require a contract update, but the architect may want a note alongside the pending SEC-002-HARDENING state-not-consumed-on-403 update that's already queued for atomic archive.

---

### BE-ACCRED-TEST-MOCK-POLISH — Test-mock hygiene for accreditations route (Backend Agent, P3)

**Status:** Landed at commit **4dae6a9** ("BE-ACCRED-TEST-MOCK-POLISH: polish revoke-branch test mock and orcid null coalescing"). 1/1 pass in `accreditations-revoke.test.ts` + 3/3 pass + 1 skipped in `accreditations.test.ts` (smoke-check for the `??` change); full backend vitest 39 files / 268 pass.

- **`backend/tests/routes/accreditations-revoke.test.ts:42-48`** — `hafCache.clear()` added in `beforeEach`. Cache bleed between sibling tests closed.
- **`backend/tests/routes/accreditations-revoke.test.ts:64-67`** — multi-signal mock SQL detection. Guard now requires both `sql.includes("'action' IN ('accredit', 'revoke')")` AND `sql.includes('FROM hafsql.operation_custom_json_view')`. Note: task spec suggested `FROM customjsonops`, but the route SQL uses `T.customJson` which resolves to `'hafsql.operation_custom_json_view'` per `backend/src/hafsql.ts:46`. Implementer used the real literal. Mirrors the SEC-003-BE round-2 pattern in `backend/tests/routes/claims.test.ts:95`.
- **`backend/tests/routes/accreditations-revoke.test.ts:68-77`** — `event_id: null` fixture comment rewritten as defensive signaling, not active coverage (matches the reality that the revoke branch has no projection path that reads event_id).
- **`backend/src/routes/accreditations.ts:141`** — `payload.orcid || null` → `payload.orcid ?? null`. Operator precision, no behavior change today.

**[TODO Architect]:** None. Self-contained.

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

**Backend re-review signal (2026-04-21, commit `9895fe9`):** Fixes already landed in a prior session under the round-3 hold but never got a signal block appended; flagging now. Ready for architect round-4 re-review.
- Finding #1 (P2 mutation-kill): `expect(hafQueryMock).toHaveBeenCalled()` added at all 4 sites — `backend/tests/routes/profile-auth-bypass.test.ts:100` (spec 1 self-broadcast) and `:143` (spec 2 authority-signed); `backend/tests/routes/orcid.test.ts:279` (SEC-AUTH-BYPASS self-broadcast) and `:319` (SEC-AUTH-BYPASS authority-signed).
- Finding #2 (P3→must-fix revoke-branch): new third spec `backend/tests/routes/profile-auth-bypass.test.ts:146-178` "treats a revoke row as unaccredited" — injects `{action:'revoke', ...}` as latest row, asserts `is_accredited:false` + `accreditation:null`, with `expect(hafQueryMock).toHaveBeenCalled()` at `:177`. Mocked-pool carve-out justification from existing file header covers this spec (pattern parallels `accreditations-revoke.test.ts`).
- Verified via targeted run: 17/17 pass across `profile-auth-bypass.test.ts` (3) + `orcid.test.ts` (14).

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

**Backend re-review signal (2026-04-21, commit `ab2baaf`):** Finding #1 landed. Ready for architect round-3 re-review.
- `backend/src/routes/orcid.ts` `POST /api/orcid/callback`: outer try/catch widened to encompass the upstream `redis.get(stateKey)` + the `authenticateRequest` dispatch (previously only wrapped the state-consume DEL + token-exchange). Any infrastructure throw on the state-read or auth path now maps to 500 INTERNAL_ERROR via the existing catch with the same message shape the DEL-throw path produces. State is not consumed when the throw fires on the read (symmetric with the 403 state-not-consumed contract). Two stale rationale comments consolidated into one block above the try.
- `backend/tests/routes/orcid.test.ts`: one new spec in the `SEC-002-HARDENING` describe block — "returns 500 when redis.get throws while reading state (state-read is inside try/catch, state not consumed)". Spies `redis.get` to throw once, asserts `redis.del` never called with `stateKey`. Skips when Redis unavailable (Map.get can't throw). Pattern matches the pre-existing Item 1 DEL-throw test.
- Verified: 15/15 pass in `orcid.test.ts`; typecheck clean.
- [TODO Architect] orcid.md doc updates from original status block (state-not-consumed-on-403 contract + NO_ACCOUNT `error.details` shape + optional common.md note) remain deferred to atomic archive.

---

### BE-CLAIMS-ERROR-POLISH — Surface bridge misconfiguration with a distinct 503 (Backend Agent, P3)

**Status:** Landed at commit **1cec6df** ("surface bridge misconfig with 503 (BE-CLAIMS-ERROR-POLISH)"). 16/16 `claims.test.ts` pass (13 pre-existing + 3 new BE-CLAIMS scenarios).

- **claims.ts:194-196** (approve handler): new guard `if (paperAuthor === config.hiveBridgeAccount && !config.pevoBridgePostingKey) return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Bridge posting key not configured')`, placed immediately before the bridge-branch auth check so operators see a dedicated 503 instead of the misleading "Only the post author can approve claims on native papers" fall-through.
- **claims.ts:290-292** (revoke handler): same guard, placed **after** basic authorization (isPostAuthor/isClaimer/isAdmin) so unrelated callers still see 403 FORBIDDEN first; the 503 fires only for authorized callers on bridge papers with no posting key. Spec line numbers (~190/~277) drifted to 194/290 after the SEC-003-BE round-2 `active_accreditations` JOIN + chain-visible-actor comment.
- **`backend/tests/routes/claims.test.ts`** — new `describe('BE-CLAIMS-ERROR-POLISH — bridge misconfig surfaces as 503')` block (3 scenarios: approve 503, revoke 503 from admin, no `broadcastJson` in either case). Per-test save/restore of `config.pevoBridgePostingKey` via `afterEach`.

No contract change required (shape is a generic `SERVICE_UNAVAILABLE` 503, fits the existing envelope).

**Architect re-review (2026-04-21c) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` (correctness/security/testing/api-contract/maintainability) on commit `1cec6df` confirmed the 503 guards work and tests are sound. One P2 cross-file inconsistency must close before archive.

1. **P2 — `bridge.ts` returns 500 INTERNAL_ERROR for the same misconfig** (`backend/src/routes/bridge.ts:158, :278`). Two bridge endpoints (registration + update) already returned 500 INTERNAL_ERROR with the identical `"Bridge posting key not configured"` message before this task. The new claims guards in commit `1cec6df` return 503 SERVICE_UNAVAILABLE — the more correct code per RFC 9110 ("deployment cannot broadcast on behalf of the bridge account right now" is service-availability, not internal-error). Result: same root cause, two codes. Fix: backport `bridge.ts` (both sites) to 503 SERVICE_UNAVAILABLE with the identical message + extract a small `assertBridgeKeyConfigured(res, paperAuthor)` helper (one return-true-if-configured, one return-false-after-sendError shape) so the four call sites (2 in bridge.ts + 2 in claims.ts) all source from one constant. Folds the round-2 P3 (helper-extraction-on-byte-identical-guards) in for free. Add one `bridge.test.ts` scenario per converted site asserting the 503 + identical error message.

**Dismissed from round-2 findings (architect review):**
- **(P3) `afterEach` save/restore ceremonial:** vitest file-level serial execution + per-test afterEach is safe; no race risk with sibling SEC-003-BE tests in the same file. The `(config as { ... })` cast matches the existing pattern. Discretionary refactor at most.
- **Pre-auth info leak on the approve guard (advisory):** dismissed. `verifyHiveSignature` runs before the guard, so unauthenticated callers never reach it. Authenticated-but-unrelated callers learn only that the paper author equals the bridge account — already public on-chain.

**Path to archive:** (1) Backend agent applies finding #1 (bridge.ts → 503 + helper extraction + 2 bridge.test.ts scenarios). (2) Architect re-reviews round-3 with `/ce-code-review`, archives.

**Backend re-review signal (2026-04-21, commit `67311b3`):** Finding #1 landed. Ready for architect round-3 re-review.
- `backend/src/routes/bridge.ts`: extracted `assertBridgeKeyConfigured(res): boolean` helper (exported). Register (`~:170`) and update (`~:288`) call sites converted from `500 INTERNAL_ERROR` / "Bridge posting key not configured" to the helper call; helper emits `503 SERVICE_UNAVAILABLE` with the identical message.
- `backend/src/routes/claims.ts`: imports `assertBridgeKeyConfigured` from `./bridge.js`; replaces the round-1 inline 503 guards at approve (`~:195`) and revoke (`~:291`). All four call sites now source from one constant message in the helper.
- Helper shape: `(res): boolean` — no `paperAuthor` parameter. In `bridge.ts` the handler is unconditionally bridge-context so the gate isn't relevant; in `claims.ts` that gate stays at the call site (`if (paperAuthor === config.hiveBridgeAccount && !assertBridgeKeyConfigured(res)) return;`). Delivers the "one constant message" goal without leaking a trivial coupling back into the helper.
- `backend/tests/routes/bridge.test.ts`: added auth-mock scaffold (mirroring `claims.test.ts` shape) plus new `BE-CLAIMS-ERROR-POLISH` describe block with 2 scenarios — register 503, update 503 — per-test save/restore of `config.pevoBridgePostingKey`. File-header justification for the `getAccreditedSet` mock added per root CLAUDE.md carve-out.
- Verified: 25/25 pass across `bridge.test.ts` (10) + `claims.test.ts` (15); typecheck clean.

---

### FE-ORCID-CALLBACK-FIXES (UI Agent, P1)

**Status:** Landed at commit `0951fef`. `_saveSession` 6-arg misuse fixed in `orcid-callback.js:148` AND `login.js:152` (same bug); `auth.expiresAt = data.expires_at` set before `_saveSession()`. `pevo_orcid_mode` removeItem moved into success handler of `completeOrcid`. New tests in `pages-orcid-callback.test.js` + `pages-login.test.js`. **Flagged follow-up:** same `_saveSession` 6-arg pattern still exists at `signup-verify.js:412/457` and `settings.js:550` — candidate for a `FE-SAVESESSION-API-MISUSE-SWEEP` task.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

**Architect re-review (2026-04-21d) — HELD PENDING FIXES:**

Review (manual-synthesis pass — see commit `e40d9dc` on why `/ce-code-review` fan-out was unavailable to the dispatched subagents, now fixed in architect CLAUDE.md) surfaced three P2 findings. User triage 2026-04-21d: fix first two in place; file third as separate sweep.

1. **P2 — `orcid-callback.js:146-159` `_handleLogin` stale-state write-window.** The old 6-arg `_saveSession(username, custody, postingKey, memoKey, false, null)` hard-coded `isAccredited=false` and `accreditation=null`. The new no-arg `_saveSession()` reads those fields from the Alpine store — which may carry values from a prior session via `_restoreSession`. Result: a ~50-200ms write-window where `localStorage.pevo_session` holds the new ORCID-logged-in username paired with the PREVIOUS account's `isAccredited` + `accreditation`. `_checkAccreditation()` self-heals via a second `_saveSession()`, but a concurrent tab's storage event or service worker reads the stale pairing in the interim. Fix: set `auth.isAccredited = false; auth.accreditation = null;` before `_saveSession()` in `_handleLogin` (matching the old hard-coded behavior).

2. **P2 — `pages-orcid-callback.test.js:9-16` test-harness gap that hides finding #1.** `mockAuthStore` declares only `{ username, isConnected, orcidVerified }` — no `isAccredited`, no `accreditation`. The fix for #1 is invisible to the test suite. Extend the mock to include both fields defaulting to post-disconnect safe values (`isAccredited: false`, `accreditation: null`), AND add a regression test: seed `mockAuthStore.isAccredited = true; mockAuthStore.accreditation = { type: 'email' }`, invoke ORCID `_handleLogin`, assert both are cleared before `_saveSession()` fires.

3. **P2 split to Pending: FE-SAVESESSION-API-MISUSE-SWEEP.** The same `_saveSession(6 args)` misuse the original commit fixed still exists at `signup-verify.js:412, :457` and `settings.js:636`. `settings.js:636` additionally passes `null` as old `expires_at`. Implementer already flagged this in the commit report; filed as a separate P2 Pending task.

**Path to archive:** (1) UI agent applies findings #1 + #2 on this task. (2) UI agent appends a re-review signal block. (3) Architect re-reviews (`/ce-code-review` directly from architect context per the updated protocol) and archives.

**UI re-review signal (2026-04-21, commit `c078940`):** Findings #1 + #2 landed. Ready for architect re-review.
- Finding #1 (stale-state write-window): `frontend/src/pages/orcid-callback.js` `_handleLogin` now sets `auth.isAccredited = false; auth.accreditation = null;` immediately before `auth._saveSession()` so the no-arg save doesn't carry stale store values into `localStorage.pevo_session`. Comment notes the synchronous reset is required because `_checkAccreditation` is async.
- Finding #2 (test-harness gap): `frontend/tests/unit/pages-orcid-callback.test.js` `mockAuthStore` extended with `isAccredited: false` + `accreditation: null` defaults. New regression test "ORCID login clears stale accreditation state BEFORE _saveSession() fires" seeds stale values, uses `mockImplementationOnce` on `_saveSession` to snapshot store state at call-time, and asserts both fields are already cleared at that instant.
- Verified: 25/25 pass in `pages-orcid-callback.test.js`; full frontend unit suite 837/837 pass; `npm run build` clean.

---

### FE-KEYCHAIN-API-MISUSE (UI Agent, P1)

**Status:** Landed at commit `c4e27f1`. `requestAddAccountAuthority` → `requestImportKey(username, wif, cb)` in `settings.js` `executeUpgrade()`. WIF derived via `dhive.PrivateKey.fromSeed(newKeys.posting).toString()` (reuses existing dynamic `dhive` import). E2E stub tightened: asserts second arg matches WIF regex `/^5[HJK][1-9A-HJ-NP-Za-km-z]{49}$/`, rejects raw hex. Unit regression test asserts `settings.js` no longer contains `requestAddAccountAuthority(`. **Grep result:** no other production callers. **Product decision outstanding:** posting-only (current) vs active/owner/memo too — implementer recommendation is posting-only (see commit report).

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

**Architect re-review (2026-04-21d) — HELD PENDING FIXES:**

Review (manual-synthesis pass) surfaced one P2 finding. User triage 2026-04-21d: broaden Keychain import to close the UX regression.

1. **P2 — `settings.js:604` Keychain has no active or memo key post-upgrade.** The `account_update` broadcast rotates owner + active + posting + memo on-chain, but only the posting WIF is imported to Keychain via `requestImportKey(username, wifPosting, cb)`. Consequences: Keychain can sign posting-auth ops (comments, votes, custom_json) but CANNOT sign active-auth ops (transfers, power-down, witness votes, future account_update) or memo-encrypt/decrypt. User has no UI signal their Keychain is incomplete; any later attempt to use Keychain on a Hive frontend for a transfer prompts for a key Keychain doesn't have. Contradicts the custody-upgrade UX promise. Fix: import posting + active + memo via three sequential `requestImportKey` calls (NOT owner — owner keys should not live in browser extensions). Update the E2E stub to assert all three keys are imported with WIF-shape, and add a unit regression asserting `executeUpgrade()` issues three Keychain import calls with three distinct WIFs.

**Path to archive:** (1) UI agent applies finding #1. (2) UI agent appends a re-review signal block. (3) Architect re-reviews and archives.

**UI re-review signal (2026-04-21, commit `1f36b7a`):** Finding #1 landed. Ready for architect re-review.
- `frontend/src/pages/settings.js` `executeUpgrade()` Keychain block now loops over `['posting', 'active', 'memo']`, deriving each WIF via `dhive.PrivateKey.fromSeed(newKeys[role]).toString()` and issuing one `requestImportKey(username, wif, cb)` per role. Owner deliberately excluded (inline comment: owner keys should not live in browser extensions).
- `frontend/tests/e2e/custody-upgrade.spec.js` stub now polls for 3 calls; asserts each WIF-shape `/^5[HJK][1-9A-HJ-NP-Za-km-z]{49}$/`; asserts 3 distinct WIFs; cross-checks each against `rederived.{posting,active,memo}.private`; asserts `rederived.owner.private` is NOT imported.
- `frontend/tests/unit/pages-settings.test.js`: dhive mock `fromSeed` now maps hex-seed input to a distinct WIF per role; new test "executeUpgrade imports posting + active + memo WIFs (three distinct) into Keychain".
- Verified: full frontend unit suite 837/837 pass; `npm run build` clean.

---

### FE-UPGRADE-CREDENTIAL-WIPE (UI Agent, P1)

**Status:** Landed at commit `dfece3e`. New `_clearSensitiveUpgradeState()` helper zeros `oldSeedPhrase`, `newSeedPhrase`, `newSeedWords`, `confirmInputs`, `upgradePassword`. Called on both success (before `upgradePhase = 'done'`) and error paths. `resetUpgrade()` refactored to use the same helper. Unit + E2E tests assert all 5 sensitive fields are empty post-upgrade. Sensitive-state audit: no other holders on the page need the wipe (handleSetPassword already zeroes on both paths).

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

**Architect re-review (2026-04-21d) — HELD PENDING FIXES:**

Review (manual-synthesis pass) surfaced two P2 findings. User triage 2026-04-21d: fix the wipe-ordering bug in place; file closure-wipe as separate defense-in-depth follow-up.

1. **P2 — `settings.js:651-658` error-path wipe-before-upgradeError ordering.** The catch block invokes `_clearSensitiveUpgradeState()` then immediately does `this.upgradeError = err.message`, which is x-text'd into the DOM. If `err.message` ever embeds key material (dhive throw, library swap, future error shape), the wiped state is effectively un-wiped via a DOM-visible error message. Fix: surface a generic localized message to the user (e.g., `t('custody_upgrade_failed')`) and `console.warn(err)` for debugging. Simpler than whitelisting known-safe error shapes. Add a test asserting `upgradeError` after an injected key-material-shaped throw does NOT contain the injected substring.

2. **P2 split to Pending: FE-UPGRADE-CLOSURE-WIPE.** Closure-captured derivatives (`oldSeed`, `oldKeys`, `newSeed`, `newKeys`, `newPubKeys`, `ownerKey`, `wifPosting`) live until GC — the wipe only covers reactive Alpine state. Defense-in-depth, no concrete exploit today, requires non-trivial refactoring. Filed as a separate P3 Pending task.

**Path to archive:** (1) UI agent applies finding #1. (2) UI agent appends a re-review signal block. (3) Architect re-reviews and archives.

**UI re-review signal (2026-04-21, commit `fd116e4`):** Finding #1 landed. Ready for architect re-review.
- `frontend/src/pages/settings.js` catch block in `executeUpgrade()` now does `console.warn('[custody upgrade]', err); this.upgradeError = this.$t('upgrade.failed')` instead of `this.upgradeError = err.message`. Raw error stays in the console for debugging; user-visible text is a generic localized message.
- New i18n key `upgrade.failed` added to `frontend/public/messages/en.json` ("Account upgrade failed. Please try again. If the problem persists, contact support."). Stubbed with the English string across the 15 other locales (`ar, cs, da, de, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`) pending translation.
- `frontend/tests/unit/pages-settings.test.js`: new test "does not leak key-material from err.message into upgradeError" injects a throw whose `err.message` contains a 64-char hex blob + 12-word BIP39-shaped seed list; asserts the generic key reaches `upgradeError` and the raw error reaches `console.warn`.
- Verified: full frontend unit suite 837/837 pass; `npm run build` clean.

---

### FE-UPGRADE-KEY-WRAPPER-ADOPT (UI Agent)

**Status:** Landed at commit `276ed8f`. `settings.js` now imports `generateMnemonic`/`validateMnemonic`/`mnemonicToSeedSync` from `../hive-keys.js` (no raw `@scure/bip39` imports, no manual `wordlist` threading). `custody-upgrade.spec.js` signature regex tightened to `/^[0-9a-fA-F]{130}$/`; pubkeys cross-checked against independently-derived values via `deriveAllKeys`; old/new seeds now distinct so broadcast exercises real rotation; `newSeedPhrase` read gated on `I've written it down` button. `@hiveio/dhive` + `@scure/bip39` exact-pinned in `package.json`.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

**Architect re-review (2026-04-21d) — HELD PENDING FIXES:**

Review (manual-synthesis pass) surfaced one P2 finding. User triage 2026-04-21d: remove the dead re-export.

1. **P2 — `hive-keys.js:98` dead `wordlist` re-export.** The module re-exports `wordlist` from `@scure/bip39/wordlists/english` as part of its public API, but after this task no external consumer imports it — the wrappers (`generateMnemonic`, `validateMnemonic`, `mnemonicToSeedSync`) handle wordlist injection internally. Violates the task's "route all consumers through the wrapper" thesis. Fix: delete `export { wordlist } from ...` (and the corresponding import if `wordlist` is only used inside `hive-keys.js` itself). The `pages-settings.test.js` mock already doesn't mock `wordlist`, confirming no test coupling to remove.

**Path to archive:** (1) UI agent applies finding #1. (2) UI agent appends a re-review signal block. (3) Architect re-reviews and archives.

**UI re-review signal (2026-04-21, commit `3195cb0`):** Finding #1 landed. Ready for architect re-review.
- `frontend/src/hive-keys.js`: `wordlist` removed from the `export { mnemonicToSeedSync, wordlist }` re-export. The top-of-module `import { wordlist }` kept because the wrappers (`generateMnemonic`, `validateMnemonic`) use it internally.
- Verified dead re-export: zero importers of `wordlist` from `hive-keys.js` across `frontend/src/` and `frontend/tests/` (only a comment reference in `pages-settings.test.js:37` mentioning "entropy/wordlist policy", no import).
- Verified: 10/10 pass in `tests/unit/hive-keys.test.js`; full frontend unit suite 837/837 pass; `npm run build` clean.

---

### FE-URL-SYNC-UTIL-EXTRACT (UI Agent, P2)

**Status:** Landed at commit `ff22ce4`. New `frontend/src/lib/url-sync.js` exports pure `localeStrippedPath(pathname)`. Handles `/en/papers` → `/papers`, `/fr/papers/` → `/papers` (trailing slash drop), `/en` → `/`, `/research-something` unchanged. Three consumers swap. `feedOwnsUrl` → `pageOwnsUrl` rename in `paper-feed.js`. Missing inner popstate guard added to `paper-feed.js`; `pageOwnsUrl()` early-out added to `researchers._syncFromUrl()`. 8 lib tests. `search._syncFromUrl` left alone per task scope.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

**Architect re-review (2026-04-21d) — HELD PENDING FIXES:**

Review (manual-synthesis pass) surfaced one P2 finding. User triage 2026-04-21d: document the coupling inline rather than widen the regex.

1. **P2 — `lib/url-sync.js:14` locale regex `/^\/[a-z]{2,3}(?=\/|$)/` case-sensitive.** The regex strips only lowercase 2-3 char locales. Sanity-check: `frontend/src/router.js` uses `SUPPORTED_LOCALES.includes(segments[1])` against `['ar', 'cs', 'da', 'de', 'en', 'es', 'fa', 'fr', 'he', 'it', 'nl', 'pl', 'pt', 'sv', 'tr', 'zh']` — case-sensitive, all lowercase, all 2 chars. So the helper's casing matches the router's own casing. Fix is documentation, not code: add a comment immediately above the regex noting "Mirrors SUPPORTED_LOCALES casing (all lowercase 2-char). Router treats non-matching casing as non-locale path. Widen only in tandem with SUPPORTED_LOCALES." Prevents a future refactor from "widening" the helper without widening the router (which would cause garbage locale-shaped prefixes to be stripped as real locales).

**Path to archive:** (1) UI agent applies finding #1 (one-line code comment). (2) UI agent appends a re-review signal block. (3) Architect re-reviews and archives.

**UI re-review signal (2026-04-21, commit `0f562c9`):** Finding #1 landed. Ready for architect re-review.
- `frontend/src/lib/url-sync.js` line 14: added two-line comment above the locale regex inside `localeStrippedPath()` — "Mirrors router SUPPORTED_LOCALES casing (all lowercase, 2 chars). Widen only in tandem with frontend/src/router.js SUPPORTED_LOCALES."
- Verified: `frontend/src/i18n.js` (re-exported via router) defines `SUPPORTED_LOCALES = ['ar', 'cs', 'da', 'de', 'en', 'es', 'fa', 'fr', 'he', 'it', 'nl', 'pl', 'pt', 'sv', 'tr', 'zh']` — all 16 lowercase 2-char codes, fully within the regex. No drift.
- Verified: 8/8 pass in `tests/unit/lib-url-sync.test.js`; full frontend unit suite 837/837 pass; `npm run build` clean.

---

### FE-LOADDISCIPLINES-OBSERVABILITY (UI Agent, P2)

**Status:** Landed at commit `7abb7d1`. `paper-feed.js` + `search.js`: added `disciplinesLoadFailed: false` state; `init()` `.catch(() => {})` replaced with `.catch((err) => { console.warn('[loadDisciplines]', err); this.disciplinesLoadFailed = true; })`. `:data-disciplines-status="disciplinesLoadFailed ? 'failed' : 'ok'"` bound on the discipline `<select>`. Playwright agents can now assert failure. `researchers.js` verified to have no disciplines dropdown — no changes there.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

**Architect re-review (2026-04-21d) — HELD PENDING FIXES:**

Review (manual-synthesis pass) surfaced one P2 finding. User triage 2026-04-21d: fix the reset-on-retry trap in place.

1. **P2 — `paper-feed.js:113-116` + `search.js:177-180` `disciplinesLoadFailed` never reset on retry.** The `.catch` sets the flag to true; `loadDisciplines` itself doesn't reset it. Today the function is init-only so the omission is inert, but any future retry path (route revisit, visibility-change reload, user-triggered retry UI) would see the flag stuck at true even after a successful load. Fix: add `this.disciplinesLoadFailed = false;` at the TOP of `loadDisciplines()` body (before the fetch) in both `paper-feed.js` and `search.js`. Add one test per file: seed `disciplinesLoadFailed = true`, call `loadDisciplines()` with a successful fetch mock, assert the flag is false. ~4 source lines + 2 tests total.

**Path to archive:** (1) UI agent applies finding #1. (2) UI agent appends a re-review signal block. (3) Architect re-reviews and archives.

**UI re-review signal (2026-04-21, commit `318e3dc`):** Finding #1 landed. Ready for architect re-review.
- `frontend/src/components/paper-feed.js` and `frontend/src/pages/search.js`: `loadDisciplines()` now opens with `this.disciplinesLoadFailed = false;` (before the fetch), so any future retry path that invokes `loadDisciplines` after a prior failure clears the flag before attempting the new load. Rationale comment added inline. (Note: `disciplines` state lives on the component `paper-feed.js`, not a page-level file as the finding described.)
- `frontend/tests/unit/components-paper-feed.test.js` + `frontend/tests/unit/pages-search.test.js`: one new regression test each — "resets disciplinesLoadFailed to false when a subsequent loadDisciplines succeeds". Seeds `disciplinesLoadFailed = true`, invokes `loadDisciplines()` with a successful fetch mock, asserts the flag is false post-call.
- Verified: 60/60 pass across both test files; full frontend unit suite 837/837 pass; `npm run build` clean.

---

### FE-SEARCH-QUERY-URL-HYGIENE (UI Agent, P3)

**Status:** Landed at commit `7652f2d`. Three P3 cleanup items. (1) `doSearch` entry trims `q`, normalizes `this.query` so input/URL/API all see the same trimmed form. (2) Filter-change policy decided: keep submit-gated, intentional asymmetry with paper-feed (user-initiated vs passive feed) — comment added inline near filter row. (3) `/papers` Alpine scope renamed `homePage` → `papersPage` (new `initPapersPage` + registered in `index.js`); home.js unchanged. New trim-roundtrip unit test.

**Test results:** Full frontend unit suite (832/832 at session end) passes; `npm run build` clean.

**Architect re-review (2026-04-21d) — HELD PENDING FIXES:**

Review (manual-synthesis pass) surfaced two P2 findings. User triage 2026-04-21d: fix both in place.

1. **P2 — `papers.js:16-22` dead `navigate()` method on `papersPage` scope.** The new `initPapersPage` copies the `homePage` shape including a `navigate(path)` method that calls `this.$store.router.navigate(path)`. The `/papers` template at the top of `papers.js` is just a `<paperFeed>` shell and doesn't invoke `navigate(...)` anywhere. Copy-paste vestige. Fix: delete the `navigate` method from the scope. If a future CTA button on `/papers` needs programmatic navigation, add it with a test at that time.

2. **P2 — `search.js:23-30` HTML comment inside template literal ships to rendered DOM.** The new 8-line submit-gated-filter-policy explanation sits inside the Alpine template string via `<!-- ... -->`. Vite/Tailwind do not strip inline template-literal HTML comments by default, so the 400-byte prose rationale is served on every `/search` page render. Benign today but sets a bad precedent for internal rationale in template comments. Fix: move the explanation ABOVE the backticks as a JS `//` block comment. Preserves the documentation for maintainers, strips it from shipped output. Optionally add a unit test loading the built template HTML and asserting the comment text is absent.

**Path to archive:** (1) UI agent applies findings #1 + #2. (2) UI agent appends a re-review signal block. (3) Architect re-reviews and archives.

**UI re-review signal (2026-04-21, commit `b5ebbb2`):** Findings #1 + #2 landed. Ready for architect re-review.
- Finding #1 (`frontend/src/pages/papers.js:16-22` dead `navigate()`): deleted. `papersPage` scope is now `() => ({})`.
- Finding #2 (`frontend/src/pages/search.js:23-30` template-literal HTML comment): 8-line submit-gated-filter-policy explanation moved verbatim OUT of the Alpine template literal and UP above the backticks as a JS `//` block comment.
- Verified grep on shipped bundle (`backend/public/assets/*.js`) for distinctive substrings — "auto-push the URL or re-run the search", "mid-compose filter tweaks", "handleSubmit is the canonical" — zero matches. The prose is stripped from the bundle as intended.
- Verified: 31/31 pass in `tests/unit/pages-search.test.js`; full frontend unit suite 837/837 pass; `npm run build` clean.

---

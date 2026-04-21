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

**Architect re-review (2026-04-21, round-4) — HELD PENDING FIXES:**

Round-4 `/ce-code-review` (testing + correctness, direct invocation per updated protocol) on commit `9895fe9`. The round-3 prescribed fix landed verbatim — and round-4 reviewers converged on the finding that **the prescription itself was insufficient**. Captured as `/ce-compound` learning `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md`.

1. **P2 — `toHaveBeenCalled()` is not a mutation-kill safeguard at a predicate-gated mock site** (testing 0.95 + correctness 0.90, 2-reviewer convergence). The mock's fallback `return { rows: [] }` fires whenever the `if (sql.includes(...) && sql.includes('account' = $1))` guard doesn't match. `toHaveBeenCalled()` passes on every call — matched branch or fallback branch. If a SQL refactor drops the authority filter entirely, the guard fails, the mock returns the fallback, outer assertions (`is_accredited:false`, `accreditation:null`) still pass, `toHaveBeenCalled()` still passes, and the load-bearing `expect(sql).toContain('required_posting_auths ?| $4::text[]')` assertion silently never runs. Fix: promote all 4 sites to `expect(hafQueryMock).toHaveBeenCalledWith(expect.stringContaining('required_posting_auths ?| $4::text[]'), expect.anything())`. The matcher fails if no call matched the expected SQL shape — which is exactly the regression the test is named for. Sites: `profile-auth-bypass.test.ts:100, 143, 177` + `orcid.test.ts:279, 319` (the SEC-AUTH-BYPASS blocks; also add to the new third revoke spec at `profile-auth-bypass.test.ts:177`).

2. **P3 — `event_id:99` in the revoke fixture is inert** (correctness COR-001, 0.95). `profile.ts:51` returns `null` before `event_id` is projected. The fixture's `event_id:99` is never read. Current comment implies meaning it doesn't have. Fix: mirror the pattern in `accreditations-revoke.test.ts` — either drop the field or add a one-line comment noting "event_id intentionally discarded on revoke branch".

3. **P3 — Revoke spec omits `params[0]` account-scoping check** (testing T-2, 0.85). Specs 1 and 2 in `profile-auth-bypass.test.ts` assert `expect(params[0]).toBe(victim)` inside the guard. The new revoke spec doesn't. Fix: add `expect(params[0]).toBe(revoked)` inside the guarded branch at `profile-auth-bypass.test.ts:~160`. One line.

**Dismissed from round-4 findings:**
- **P3 Carve-out condition (c) compliance weak** (project-standards F-001, 0.62). The real-HAF variant for the revoke branch on `/api/profile/:username` is demonstrably infeasible per-test (requires broadcasting a revoke from an authority account + waiting on HAF indexing). Clause (c)'s spirit is covered by the 4 sibling sites in `accreditations.ts` + `orcid.ts` that DO have real-HAF tests of the same authority-filter pattern. Not paperwork-theater-filing a follow-up.

**Filed as new Pending task (out of scope for this hold):**
- `backend-mock-guard-assertion-sweep.md` — P3 broader sweep. The `toHaveBeenCalled()` → `toHaveBeenCalledWith(matcher, ...)` promotion should land across **all** predicate-gated mock sites in the backend test suite, not just these 5. Known current sites enumerated in the learning doc at `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md`.

**Path to re-archive:** (1) Backend applies items #1-3. (2) Backend re-review signal block. (3) Architect re-reviews round-5 with `/ce-code-review` and archives.

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

**Architect re-review (2026-04-21, round-3) — HELD PENDING FIXES:**

Round-3 `/ce-code-review` on commit `ab2baaf`. The round-2 hold-block widening (try/catch encompasses state-read + auth + DEL + token-exchange) landed correctly: 400 BAD_REQUEST path on `storedMode=null` still fires via normal early-return (not catch); 403 state-not-consumed preserved because `sendError(403) + return` exits before DEL; DEL throw still catches as 500 consistent with round-1. Round-3 surfaced a defense-in-depth gap and 2 test-coverage gaps adjacent to the commit's stated behavior.

1. **P2 — `sendError` has no `res.headersSent` guard** (correctness COR-005, 0.75). `backend/src/response.ts:19` calls `res.status(httpStatus).json(...)` unconditionally. The widened try now wraps `authenticateRequest` (orcid.ts:184), which internally uses `verifyHiveSignature`. If `verifyHiveSignature` ever both writes a response AND throws (currently not reachable per the promise/finish-listener structure, but not structurally enforced), the outer catch fires `sendError(res, 500, ...)` on an already-responded res, Express logs "Cannot set headers after they are sent", the response stream is corrupted. Fix: add `if (res.headersSent) { logger.warn({}, 'sendError called after response sent'); return; }` at the top of `sendError` in `backend/src/response.ts`. Defense-in-depth; closes any future expansion of the pattern (e.g. the SEC-AUTH-BYPASS and SEC-002-TOCTOU-LOCK catch blocks that also widen try/catch around middleware). Architect-owned file, so backend agent must flag the edit via `[TODO Architect]` or the architect lands it during re-review.

2. **P2 — Test uses `mockImplementationOnce` on `redis.get` — call-order-dependent, not key-targeted** (testing T-001, 0.88). The new "redis.get throws" spec at `orcid.test.ts:413-431` assumes the first `redis.get` call on the singleton is the stateKey read. Works today coincidentally (the throw exits the try before other `redis.get` calls happen). If a future change adds a `redis.get` upstream of the stateKey read (e.g. a per-request session lookup), the mock silently intercepts the wrong call and the test either passes for the wrong reason or fails for a confusing reason. Fix: swap to `mockImplementation(async (key) => { if (key === stateKey) throw new Error(...); return origGet(key); })`. Key-targeted, refactor-stable. ~6 lines.

3. **P3 — `authenticateRequest` throws → 500 path untested** (testing T-002, 0.85). The widened try wraps auth. The commit message names "auth dispatch error" as a covered path. No test exercises `verifyHiveSignature` synchronously throwing before `sendError + resolve`. Fix: one spec mocking `verifyHiveSignature` (or the underlying redis replay-cache it depends on) to reject synchronously for an authed-mode callback. Assert 500 INTERNAL_ERROR + `delSpy.mock.calls.map(c => c[0])` does NOT contain `stateKey` (state-not-consumed on infra error, symmetric with the 403 path).

4. **P3 — 403 state-not-consumed contract has no assertion in the existing 403 test** (testing T-003, 0.75). The 403 test at `orcid.test.ts:140` asserts `res.status === 403` + `broadcastJsonMock not called` but never asserts `redis.del` was NOT called with `stateKey`. A refactor that moves DEL before the username-mismatch check would go undetected. Fix: add `expect(delSpy.mock.calls.map(c => c[0])).not.toContain(stateKey)` to the existing 403 spec. One line.

**Dismissed from round-3 findings:**
- **P3 Emdashes in newly-added comments** (project-standards PS-001, 0.72). Rule is user-facing text scope; comments are fine. Pre-existing pattern.

**Path to re-archive:** (1) Backend applies items #1-4 (item #1 requires touching `backend/src/response.ts` — architect-owned — so either flag for architect with a `[TODO Architect]` block, or the architect lands it at re-review time). (2) Backend re-review signal block. (3) Architect re-reviews round-4 with `/ce-code-review` and archives. At archive, land the deferred `orcid.md` contract updates from the original `[TODO Architect]` block (state-not-consumed-on-403 contract + NO_ACCOUNT `error.details` shape + optional common.md note) as a single atomic edit.

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

**Architect re-review (2026-04-21, round-3) — HELD PENDING FIXES:**

Round-3 `/ce-code-review` on commit `67311b3`. The round-2 hold (backport bridge.ts 500→503, extract `assertBridgeKeyConfigured` helper, 4 call sites source from one constant) landed correctly: all 4 sites use the helper, bridge.test.ts has 2 new 503 specs with proper save/restore, typing is sound. Round-3 surfaced one logic bug in the revoke handler's guard ordering and two contract-documentation gaps the commit introduced but didn't close.

1. **P2 — `claims.ts:291` guard blocks `isClaimer` self-revoke on bridge paper when key is unset** (correctness C-01, 0.72). The revoke handler's authorization gate at lines 274-276 passes for `isClaimer` regardless of paper type. The `assertBridgeKeyConfigured` guard at line 291 then fires unconditionally for any bridge paper when the key is missing — including the self-revoke case. Comment at line 298 says "falls through to the client-signed return-operation path below" (no bridge key needed for client-signed), but the line-291 guard blocks that path before it can fire. A claimer self-revoking on a bridge paper when `pevoBridgePostingKey` is unset gets 503 SERVICE_UNAVAILABLE instead of the expected 200 + client-broadcast operation payload. Fix: reorder. Move the `assertBridgeKeyConfigured` guard BELOW the client-signed branch so it fires only when the server actually needs to broadcast with the bridge key. Alternative: gate the guard on `!isClaimer && paperAuthor === config.hiveBridgeAccount` so it skips when the caller will client-sign. Cleaner shape is reordering — the guard's job is "block when we NEED the key," which is after the client-signed branch has had its chance. Add one test: `isClaimer` authenticated + bridge paper + `pevoBridgePostingKey` unset → 200 with operation payload (not 503).

2. **P2 — `agents/docs/api-contracts/bridge.md` lines 146 and 187 still document `INTERNAL_ERROR`** (api-contract AC-001, 0.92). Both endpoints previously returned 500 INTERNAL_ERROR; round-2 changed to 503 SERVICE_UNAVAILABLE. Contract doc never updated. **Architect-side fix at archive** — I own the contract file. Rewrite both lines during archive as part of item #3 bundle.

3. **P2 — `SERVICE_UNAVAILABLE` absent from `common.md` error codes table** (api-contract AC-002, 0.95). The round-2 work (commit `52419c5`) added `SERVICE_UNAVAILABLE` to the `ErrorCode` TS union to satisfy the compiler but didn't update the standard error codes table in `agents/docs/api-contracts/common.md` lines 48-59. Any consumer that validates error codes against the documented set will treat SERVICE_UNAVAILABLE as unknown. **Architect-side fix at archive** — add a row to the standard error codes table: `| 503 | SERVICE_UNAVAILABLE | Backend dependency not configured or temporarily unavailable |`. Bundle with item #2.

**Dismissed from round-3 findings:**
- **P3 `assertBridgeKeyConfigured` naming — "assert" implies throw-on-failure convention, returns boolean** (maintainability M-001, 0.68). Inline comment above the function already documents the call convention. Rename is cosmetic churn. File mental note if a second boolean-returning `assert*` helper joins the codebase.
- **(P3) `afterEach` save/restore ceremony** — round-2 dismissal stands. Vitest file-level serial execution + per-test afterEach is safe.
- **(advisory) Pre-auth info leak on approve guard** — round-2 dismissal stands. `verifyHiveSignature` runs before the guard.

**Path to re-archive:** (1) Backend applies item #1 (reorder + test). (2) Backend re-review signal block. (3) Architect re-reviews round-4 with `/ce-code-review`. (4) Architect lands items #2 and #3 (contract doc updates) during archive as a single atomic edit. All 4 changes archive together.

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

**Architect re-review (2026-04-21) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` on commit `c078940` (correctness + testing + julik-frontend-races personas). The round-1 hold-block requirements (clear stale accreditation state before `_saveSession`, extend mockAuthStore + regression test) landed correctly ("BOTH HOLD-BLOCK REQUIREMENTS MET" per correctness reviewer). Round-2 surfaced an adjacent P2 asymmetry with other login paths and several test-hygiene items.

1. **P2 — `_handleLogin` uses bare `_checkAccreditation()` instead of `_startAccreditationPolling()`** (julik-frontend-races JR-2, 0.88; merged with JR-3 0.85). Sibling login paths `loginFromResponse` and `connect` in `frontend/src/auth.js` both call `_startAccreditationPolling()` after writing session state; this provides the 60s retry loop so a transient accreditation-fetch failure doesn't leave a non-accredited-looking store permanently. `_handleLogin` on the ORCID callback path calls only `_checkAccreditation()` — a single fetch. If the fetch fails transiently (network flap, backend slow), the store stays at `isAccredited=false` / `accreditation=null` forever (or until manual reload). Fix: replace `auth._checkAccreditation()` with `auth._startAccreditationPolling()` at `frontend/src/pages/orcid-callback.js:~166`. One-line change; matches the pattern other login paths use. Add one test asserting `_startAccreditationPolling` is called exactly once post-ORCID-login. Closes JR-2 and JR-3 together.

2. **P3 — Regression test snapshots in-memory store, not actual localStorage payload** (julik-frontend-races JR-5, 0.80). The new "clears stale accreditation state BEFORE _saveSession" test uses `mockImplementationOnce` on `_saveSession` to capture store state at call-time. It does NOT assert that the actual `localStorage.setItem('pevo_session', ...)` payload reflects the cleared state. A broken `_saveSession` that reads the wrong store fields would pass this test. Fix: after the existing `snapshotAtSave` assertions, add `expect(JSON.parse(localStorage.getItem('pevo_session'))).toMatchObject({ isAccredited: false, accreditation: null })` to cover the end-to-end persistence claim. (The real `_saveSession` is mocked in this test, so this assertion requires either un-mocking _saveSession for this one spec or pinning the test at a level where the real localStorage write happens. Implementer picks the shape; either is fine.)

3. **P3 — No call-count assertion on `_saveSession`** (testing T1, 0.95). Neither the existing "handles login mode" test nor the new stale-state test asserts `toHaveBeenCalledTimes(1)`. A refactor introducing a second `_saveSession` call (double-save) would pass. Fix: add `expect(mockAuthStore._saveSession).toHaveBeenCalledTimes(1)` to both tests. 2 lines.

4. **P3 — Dead `vi.useFakeTimers()` in the new stale-state test** (testing T2, 0.90). The test calls `vi.useFakeTimers()` at top and `vi.useRealTimers()` at the end but never advances timers, never asserts navigation, never depends on any setTimeout behavior. Noise. Fix: remove both calls.

**Dismissed from round-2 findings:**
- **P2 Transient `_checkAccreditation` failure leaves store permanently false** (julik-frontend-races JR-3, 0.85). **Subsumed by item #1**: starting the polling loop provides the retry path. Once #1 lands, JR-3 dissolves.
- **P3 500ms redirect setTimeout not canceled on component teardown** (julik-frontend-races JR-4, 0.75). Latent bug for page-destroy races. Filed as separate Pending task `frontend-orcid-callback-teardown-cleanup.md` — affects other setTimeout call sites in the callback flow, not just this one.
- **P3 Pre-existing `_saveSession` 6-arg misuse at `signup-verify.js` and `settings.js`**. Already filed as `FE-SAVESESSION-API-MISUSE-SWEEP` per the original task's split-to-Pending decision.
- **P3 Storage-event two-write gap** (julik-frontend-races JR-1). Not a defect — storing `false` while the fetch is in flight is strictly safer than the prior behavior of storing stale `true`. Gap is bounded to one network round trip.

**Filed as separate Pending task (out of scope for this hold):**
- `frontend-orcid-callback-teardown-cleanup.md` — P3. Audit all setTimeout / setInterval / pending-promise call sites in `orcid-callback.js` for component-destroy cleanup. Store IDs in component state, clear in `destroy()`. Small scope but touches more than just the one site flagged.

**Path to re-archive:** (1) UI agent applies items #1-4. (2) UI agent re-review signal block. (3) Architect re-reviews round-3 with `/ce-code-review` and archives.

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

**Architect re-review (2026-04-21) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` on commit `1f36b7a` (correctness/security/testing). Round-1 hold (broaden Keychain import to 3 keys) landed cleanly and the 3-key loop works as designed. Round-2 surfaced a new P1 ordering bug that was latent in round-1's single-key version and becomes more exploitable with 3 sequential popups.

1. **P1 — Partial-import lockout state via ordering bug** (security 0.82 + correctness 0.87, 2-reviewer convergence). The current sequence inside `executeUpgrade()` is: (a) `account_update` broadcast [**IRREVERSIBLE** — rotates all 4 authorities on-chain], (b) Keychain import loop with 3 sequential popups, (c) on success `/api/custody/upgrade` backend cleanup, (d) mnemonic wipe. If the user clicks Deny on Keychain popup 2 or 3, the Promise rejects, the outer catch wipes the mnemonic from Alpine state, and step (c) never fires. Backend retains stale encrypted keys for the old (now-superseded) authorities; on-chain authorities are already the new keys; mnemonic is gone from the DOM. The user's session is wedged — old keys don't work on-chain, backend doesn't have the new keys, mnemonic can't be recovered from state. Reachable via a single click on a Keychain permission dialog. Fix: reorder so the atomic pair `(broadcast, backend cleanup)` happens together, and Keychain import becomes a best-effort step with a soft warning UI (toast/banner, NOT upgradeError):
    - Before broadcast: unchanged setup.
    - After broadcast: immediately call `/api/custody/upgrade` backend cleanup. Failure here is a real error and surfaces upgradeError (this is the only remaining irreversible-pair gap).
    - After backend cleanup: Keychain import loop. Each role's failure becomes a warning ("Keychain import incomplete — your `<role>` key was not imported; you can retry from settings later") but does NOT clear the mnemonic or mark upgrade as failed. upgradePhase advances to 'done'.
    - After loop (success OR partial): `_clearSensitiveUpgradeState()` wipes the mnemonic.
    Also: surface the Keychain-incomplete state via a new `upgradeWarnings: string[]` array so the user can see which roles succeeded and which didn't. i18n keys for each role's import-warning message.

2. **P2 — No test for mid-loop Keychain denial** (testing 0.92). The round-1 fix's 3-key loop has no coverage for `requestImportKey` returning `{ success: false }` on call index 0 or 1. Production-reachable (user cancels dialog). Fix: with the #1 reorder landed, add two specs — (a) stub denies on call index 1 (active) → assert backend cleanup fired, assert upgradePhase === 'done', assert upgradeWarnings contains the active-role message; (b) stub denies on call index 0 (posting) → same assertions with posting message. Covers the new best-effort semantics.

3. **P3 — Unit test WIF stub produces 51-char strings, not 50** (correctness C3, 0.82). `stubWifForHex` uses `'5K' + pad.repeat(49)` = 51 chars. Real Hive WIFs are 50 chars (2-char prefix + 48 base58). Doesn't affect correctness of production (dhive fully mocked) but makes the owner-exclusion assertion hard-code the stub output rather than derive it from the stub function — a stub change could silently break the check. Fix: change the stub to produce 50-char output (`'5K' + pad.repeat(48)`). Replace the hard-coded owner-WIF literal in the assertion with `stubWifForHex(<owner-seed>)` so any stub change flows through.

**Dismissed from round-2 findings:**
- **P3 No positional assertion (posting imported first)**. With the #1 reorder, Keychain import is best-effort and order no longer load-bearing. File mental note if a future caller reintroduces order dependence.
- **P3 `newKeys[role]` unguarded if `deriveHiveKeys` drifts**. YAGNI. `deriveHiveKeys` unconditionally populates all 4 roles today; a future refactor breaking that contract will be caught by that refactor's tests.
- **P3 WIF strings in closure memory during 3-popup window** (SEC-UPGRADE-WIF-IN-CLOSURE). Acknowledged as FE-UPGRADE-CLOSURE-WIPE follow-up; no JS fix at this layer.
- **P3 `newKeys.owner` hex seed in scope through Keychain loop** (SEC-UPGRADE-OWNER-SEED-IN-SCOPE). Not a regression; the importRoles literal exclusion is structurally correct and tested both ways.

**Path to re-archive:** (1) UI agent applies items #1-3 on this task. (2) UI agent appends a re-review signal block. (3) Architect re-reviews round-3 with `/ce-code-review`. Item #1 is cross-cutting (changes settings.js UX + i18n + tests); expect a thorough review.

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

**Architect re-review (2026-04-21) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` on commit `fd116e4`. The round-1 hold (generic localized message + `console.warn` instead of raw `err.message` in `executeUpgrade()` catch) landed correctly. Round-2 surfaced one P2 sibling-catch gap (same bug in `startUpgrade`) and two P3 test-hardening items.

1. **P2 — `startUpgrade()` catch at `settings.js:542` still binds `err.message` to `upgradeError`** (correctness COR-01, 0.85). The round-1 fix hardened `executeUpgrade()`'s catch but the sibling catch in `startUpgrade()` still does `this.upgradeError = err.message || this.$t('upgrade.generationFailed')`. `upgradeError` is x-text'd into the DOM at line 38. Immediate risk is low (generateMnemonic is a pure local BIP39 call, unlikely to embed key material in its error) but the invariant round-1 established — "upgradeError never carries `err.message`" — is broken by this sibling catch. Any future expansion of `startUpgrade()`'s try block that calls into a library reintroduces the vulnerability without a visible red flag. Fix: apply the same pattern. `console.warn('[custody upgrade:generate]', err); this.upgradeError = this.$t('upgrade.generationFailed')`. Verify `upgrade.generationFailed` key exists in `en.json` (add + stub across 15 locales if missing). Add one test asserting `startUpgrade` failure does not leak `err.message` contents into `upgradeError`.

2. **P3 — `$t` stub in unit tests returns key verbatim; doesn't guard the `$t('key') || err.message` regression class** (correctness COR-02, 0.82). The stub `comp.$t = (key) => key` never returns falsy, so a future refactor changing the catch to `this.upgradeError = this.$t('upgrade.failed') || err.message` passes the current test. In production, any locale where `$t` returns `''` for a missing key would cause `upgradeError` to fall through to `err.message` (leak). Fix: change the stub to return a distinguishable non-empty marker (e.g. `comp.$t = (key) => 't:' + key`) and assert `expect(comp.upgradeError).toMatch(/^t:/)`. A regression using the OR-fallback pattern would fall through to `err.message` (which does NOT start with `t:`) and fail the new matcher.

3. **P3 — `console.warn` assertion pins `calls[0]` without filtering on `[custody upgrade]` prefix** (correctness COR-03, 0.90). `warnSpy.mock.calls[0]` grabs the FIRST warn. If any code path inside `executeUpgrade()` or its mocks emits a warn before the catch block (e.g. a mock throws a React-style warning), `calls[0]` is that earlier warn, and the `expect(warnedStr).toContain(leakHex)` assertion runs against the wrong error object. Fix: filter `warnSpy.mock.calls` by `c[0] === '[custody upgrade]'` before extracting the error object. Refactor-stable.

**Dismissed from round-2 findings:**
- **P3 4 other catch blocks (`handleSetPassword`, `handleEmailSubmit`, `handleEmailDelete`, `handleOrcidLink`) still bind err.message to DOM** (RR-01). Filed as separate Pending task (below). Lower risk than the upgrade flow (no key material in those code paths) but pattern-consistency matters.
- **P3 console.warn not stripped in production bundle** (RR-02). Correct by design — Vite config does not `drop:['console']`, and the warn is intended for production operator diagnostics.
- **P3 15 non-English locale stubs contain English placeholder** (RR-03). Accepted beta pattern per commit message. Translation follow-up is continuous, not gated on this task.

**Filed as separate Pending tasks (out of scope for this hold):**
- `frontend-settings-error-message-sanitize-sweep.md` — P3. Audit `handleSetPassword`, `handleEmailSubmit`, `handleEmailDelete`, `handleOrcidLink` (and any other `this.<field>Error = err.message` patterns across `frontend/src/`) for the same pattern; apply the generic-localized-message + console.warn fix uniformly.
- `docs-locale-stub-convention.md` — P3 tooling/convention. Neither root `CLAUDE.md` nor `agents/ui/CLAUDE.md` documents a locale-stub convention (marker format, tracking mechanism). Future contributors have no signal that English-in-non-English-locale strings need translation. Standardize.

**Path to re-archive:** (1) UI agent applies items #1-3. (2) UI agent re-review signal block. (3) Architect re-reviews round-3 with `/ce-code-review` and archives.

---


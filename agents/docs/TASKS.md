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

**Goal:** Batch P2/P3 items from SEC-004-UI review. Not merge-blockers for the SEC-004 atomic pair — ship after.

**Changes:**
1. **`orcid-callback.js:130` orphaned `pevo_signup_orcid_name`** — either remove the `setItem` (if auto-fill abandoned) or add `removeItem` in `signup.js init()` (and optionally read into `fullName`).
2. **`settings.js` handleSetPassword mutation order** — patch `emailStatus` FIRST, flip `passwordSetDone=true` LAST. If the spread throws, form isn't stuck in success state while emailStatus is un-patched.
3. **Collapse overlapping success signals.** Drop `passwordSetDone` — the outer `x-if` on `emailStatus.has_password === false` (post-SEC-004-UI field-name fix) already hides the section on success.
4. **`orcid-no-password.spec.js:217-227` — Alpine internals.** Replace `root._x_dataStack[0]` with `Alpine.evaluate(root, 'newPassword = "..."')`.
5. **`orcid-no-password.spec.js:209` — brittle selector.** Add `data-testid="recover-method-orcid"` to the tab button; use that selector.
6. **`pages-settings.test.js` double-guard gap** — test `handleSetPassword` with `passwordSubmitting=true` pre-set; assert no API call.
7. **Strip task-ID refs** (`SEC-004` / `SEC-004-BE` / `SEC-004-UI`) from code comments across signup.js, recover.js, settings.js, api.js. Keep WHY prose.
8. **Placeholder-translation markers for 15 non-English locales** — prefix untranslated strings with `[TODO]` OR add `_todo_keys` array listing untranslated keys. Pick one; document convention in ui/CLAUDE.md.
9. **Resend-button-hide regression test** — `signup.js:150` adds `x-show="!resendSuccess && !orcidToken"` to hide resend on the ORCID branch. The handler body is already guarded (unit-tested in SEC-004-UI follow-up), but the template-level hide has no test surface. Add a small Playwright spec (or extend an existing one) that drives signup to `submitted: true` with `orcidToken` set and asserts `page.getByRole('button', { name: /resend/i })` is not visible. Defense-in-depth for the ORCID-branch-never-sends-password invariant.

**Non-goals:** Splitting settings.js (separate refactor). DRY password validation (FE-PASSWORD-POLICY-DRY).

**Deliverable:** Move to Review.

---

### PASSWORD-POLICY-HARMONIZE — Cross-cutting FE+BE password-policy harmonization (Backend + UI, P3)

**Surfaced by:** SEC-004-BE review triage (2026-04-21).

**Context:** FE-PASSWORD-POLICY-DRY and BE-PASSWORD-POLICY-DRY extract shared helpers in each stack independently. They will drift unless harmonized explicitly.

**Goal:** After both single-stack extractions land, harmonize so FE and BE cannot diverge silently:
1. Document the canonical policy in `agents/docs/api-contracts/auth.md`.
2. Add `// Keep in sync with frontend/src/password-policy.js` pointer (and vice versa) in both helpers, OR centralize via a JSON schema that both consume.
3. Add a CI check (grep or type-level) that fails when only one side changes.

**Non-goals:** Changing the policy itself. Adding zxcvbn or other strength tools.

**Blocked by:** FE-PASSWORD-POLICY-DRY + BE-PASSWORD-POLICY-DRY.

**Deliverable:** A future unilateral policy change on one side breaks CI, not production.

---

## Review

### BE-ARGON2-PARAMETER-LOCK — Centralize argon2id options across signup/recover/set-password (Backend Agent, P3)

**Status:** Implemented. New `backend/src/lib/argon2-options.ts` exports `ARGON2_OPTIONS` as a frozen `as const` object with `{ type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 }` — numerically identical to node-argon2 v0.31's current defaults, so no hashing-cost regression, but now explicit and drift-resistant. All 5 `argon2.hash` call sites now consume the constant: `auth.ts:33` (SENTINEL_ARGON2_HASH_PROMISE), `auth.ts:157` (signup), `auth.ts:586` (reset), `auth.ts:760` (recover), `settings.ts:384` (set-password). Inline `{ type: argon2.argon2id }` objects are gone. `argon2.verify` call sites (`auth.ts:293/:403/:415`, `custody.ts:193`, `signup-verify.ts:117`) intentionally unchanged — `verify` reads params from the stored hash's encoded prefix, so routing those through `ARGON2_OPTIONS` would be wrong.

New `backend/tests/lib/argon2-options.test.ts` (5 specs): argon2id variant assertion, OWASP minimum guards (memoryCost ≥ 19456, timeCost ≥ 2, parallelism ≥ 1), and one end-to-end `argon2.hash` + `argon2.verify` roundtrip asserting `$argon2id$`-prefixed output — catches structural typos in `ARGON2_OPTIONS` that TS widening would miss. 5/5 pass.

Full backend vitest suite: **254 pass + 3 skipIf across 38 files, no failures.** Typecheck: clean on all touched files; the two pre-existing `claims.ts` `SERVICE_UNAVAILABLE` type errors are BE-CLAIMS-ERROR-POLISH (separate Review entry), not this task.

**[TODO Architect]:** None. No API contract surface change; no user-facing error message change; `auth.md` doesn't describe argon2 params and doesn't need to.

**Unblocks:** PASSWORD-POLICY-HARMONIZE still gated on FE-PASSWORD-POLICY-DRY (which landed in commit `a753773`) + BE-PASSWORD-POLICY-DRY (Review, below). This task is orthogonal.

---

### BE-PASSWORD-POLICY-DRY — Extract shared password-policy helper (Backend Agent, P3)

**Status:** Implemented. `backend/src/lib/password-policy.ts` now exports `MIN_PASSWORD_LENGTH = 10`, `PASSWORD_POLICY_MESSAGE`, and `isPasswordValid(pw: unknown): boolean`, mirroring `frontend/src/password-policy.js`. `auth.ts` (5 sites: signup, signup-ORCID branch, reset-password, recover-ORCID branch, recover-seed-phrase branch) and `settings.ts` (1 site: set-password) now delegate the length+class rule to `isPasswordValid`. Inline `length < 10` checks, the `/[a-z]/ && /[A-Z]/ && /[0-9]/` triple, and their duplicated sendError strings are gone. New `backend/tests/lib/password-policy.test.ts` with 10 specs covering length boundary (exactly 10 passes, 9 fails), each character class individually missing, non-string inputs (undefined/null/number/object/array/boolean), empty string, and a sanity assertion that `PASSWORD_POLICY_MESSAGE` names every criterion. 10/10 pass. Full backend vitest suite: 248/252 pass + 3 skipIf across 37 files; the one failure (`recover.test.ts:440` sentinel-argon2 ≥50ms timing check, got 43–46ms under full-suite parallelism) is unrelated to this diff and passes on isolated re-run (16/16). Typecheck clean on all touched files; two pre-existing `claims.ts` `SERVICE_UNAVAILABLE` type errors are BE-CLAIMS-ERROR-POLISH, not this task.

**Note on error-message shape:** the original 6 sites surfaced TWO distinct errors (`"Password must be at least 10 characters"` and `"Password must contain lowercase letters, uppercase letters, and numbers"`). Since `isPasswordValid` returns a single boolean mirroring the FE helper, call sites now surface ONE combined message: `"Password must be at least 10 characters and contain lowercase letters, uppercase letters, and numbers"`. Chosen over diverging from FE's boolean shape or introducing a second granular helper — `agents/docs/api-contracts/auth.md` describes the policy as a single rule, not as two separate error strings, so no contract shape change.

**[TODO Architect]:** No contract-shape change required on `auth.md`. Optionally fold the unified message string into the policy description at `auth.md:55` for traceability; current wording ("required, at least 10 characters with lowercase, uppercase, and numbers") already matches the new runtime message semantically.

**Unblocks:** PASSWORD-POLICY-HARMONIZE (still Pending; it waits on this + FE-PASSWORD-POLICY-DRY, which already landed in commit `a753773`).

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

### SEC-003-BE — Fix bridge-claim approve/revoke authorization (Backend Agent)

**Status:** Implemented. `backend/src/routes/claims.ts` approve-path now requires caller to be admin OR approved co-author on bridge papers (self-approval rejected); revoke-path drops `isBridgeAdmin` from the OR-gate and tightens bridge-key broadcast to `paperAuthor === hiveBridgeAccount && isAdmin && pevoBridgePostingKey`. New `isApprovedCoAuthor` helper, fails closed on HAF error. Schema note: the HAF `authorship_claims` CTE uses status `'accepted'` (not `'approved'` as the original spec text said) — code matches schema. 11 test scenarios in new `backend/tests/routes/claims.test.ts` (10 from spec + 1 added during review triage for native admin-revoke branch coverage). Config mock overrides `hiveBridgeAccount: 'pevotest.bridge'` distinct from admin so tests exercise production BRIDGE≠ADMIN asymmetry. 11/11 pass. Full suite green.

**Review (CE) findings triaged (2026-04-21):**
- B1 (P2, bridge-approve misleading error on missing posting key) → filed as **BE-CLAIMS-ERROR-POLISH** (P3 follow-up).
- B2 (native admin-revoke branch untested) → fixed in this task; added scenario 11.
- B3 (`getAppPool() => null` mock) → dismissed; null crashes loudly on future Bearer tests.
- B4 (isApprovedCoAuthor CTE cost) → dismissed; rate-limited endpoint.
- B5 (BRIDGE===ADMIN in dev) → fixed in this task; distinct BRIDGE in config mock.
- B6 (isAdmin single-value equality) → dismissed; admin is singular by product design (memory saved).

**Curl reproducers (bridge approve + bridge revoke by random user → 403 FORBIDDEN):**
```bash
# (a) bridge approve by random authed user
curl -i -X POST "http://localhost:3000/api/papers/${HIVE_BRIDGE_ACCOUNT}/bridge-paper-sec003/claims/claimeraccount/approve" \
  -H "X-Hive-Username: someintruder" \
  -H "X-Hive-Signature: <valid-sig>" \
  -H "X-Hive-Timestamp: $(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  -H "Content-Type: application/json" -d '{}'
# → 403 {"error":{"code":"FORBIDDEN","message":"Only the platform admin or an approved co-author can approve claims on bridge papers"}}

# (b) bridge revoke by random authed user
curl -i -X POST "http://localhost:3000/api/papers/${HIVE_BRIDGE_ACCOUNT}/bridge-paper-sec003/claims/claimeraccount/revoke" \
  -H "X-Hive-Username: someintruder" \
  -H "X-Hive-Signature: <valid-sig>" \
  -H "X-Hive-Timestamp: $(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  -H "Content-Type: application/json" -d '{"reason":"test"}'
# → 403 {"error":{"code":"FORBIDDEN","message":"Not authorized to revoke this claim"}}
```

**[TODO Architect]:** update the claims routes contract file (architect-decided: `papers.md`, since the routes are `/api/papers/:author/:permlink/claims/...`) to document:
- New 403 responses on approve: "Only the platform admin or an approved co-author can approve claims on bridge papers" + "Claimer cannot approve their own claim".
- Revoke authorization is now strictly `isPostAuthor || isClaimer || isAdmin`; bridge-key server-side broadcast fires only when admin + bridge paper.

**Architect re-review (2026-04-21b) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` surfaced 5 findings. Must land before archive.

1. **P2 — `isApprovedCoAuthor` builds `active_accreditations` CTE but never JOINs it** (`backend/src/routes/claims.ts:64-108`). The implementer set up the revocation-aware machinery (the CTE is declared in `buildWith`) and dropped the final link — the SELECT reads only from `authorship_claims`. A co-author whose accreditation was later revoked can still co-sign bridge-claim approvals in perpetuity, since the accepted-claim row on HAF is immutable. This silently contradicts the PEvO trust model where revocation is meaningful (accreditation is the trust layer per root CLAUDE.md). Fix: change the SELECT to `SELECT 1 FROM authorship_claims ac JOIN active_accreditations a ON a.account = ac.claimer WHERE ac.paper_author = ... AND ac.paper_permlink = ... AND ac.claimer = ... AND ac.status = 'accepted' LIMIT 1`. Semantics: "currently accredited AND has accepted claim." Matches the other authority-filtered sites (`getAccreditedSet`, `findAccreditedAccountWithOrcid`) which all filter live on revocation.

2. **P2 — Fragile SQL detection in test mock** (`backend/tests/routes/claims.test.ts:~87`). Pool-mock branches on `sql.includes("status = 'accepted'")` — silent-fail risk under query refactor (constant extraction, quote-style change, the JOIN fix in #1). Change to a multi-signal match: `sql.includes('FROM authorship_claims') && sql.includes("status = 'accepted'")`. The double-signal requires both the target relation AND the target status, surviving most refactors that keep one but drop the other.

3. **P2 — HAF-throw fail-closed path untested.** The `isApprovedCoAuthor` `catch` block (returns `false` on throw) has no test scenario. The CLAUDE.md carve-out explicitly names this as one of the mocked-pool justifications. Add one scenario: `queryFn.mockRejectedValueOnce(new Error('ECONNRESET'))` for the co-author lookup, POST bridge-paper approve as a seeded-approved co-author, assert `403 FORBIDDEN` AND `broadcastJson` NOT called. The negative-invariant assertion ("bridge key not used") is the load-bearing check — it proves the fail-closed didn't just return an error code while still having done something dangerous. ~10-line test block.

4. **P3 — Missing symmetric native-claimer-revoke test.** Bridge-paper claimer-revokes-own-claim is tested; the native-paper equivalent isn't. The code path is identical semantically (claimer can always revoke regardless of paper type); the test exists to mutation-kill that invariant. ~15-line test block.

5. **P3 — Chain-visible-actor comment on native-admin-revoke.** The code broadcasts admin-revokes-on-native-paper under the admin account's posting auths, not the original paper-author's. Add a one-line comment at the relevant broadcast site in claims.ts noting the chain-visible-actor semantic (future reader should understand that the admin revoke produces a chain op visibly signed by admin, not by paper author).

**Dismissed from round-2 findings:** round-2 P3 on cj.json field selection cleanup (cosmetic, not defect-class). BE-CLAIMS-ERROR-POLISH already filed as separate Pending task — not duplicated here.

**Path to archive:** (1) Backend agent applies findings 1-5. (2) Architect re-reviews with `/ce-code-review` once + updates `papers.md` per the [TODO Architect] note above, adding a note on the revocation-JOIN semantic. (3) Archive.

**Backend re-review signal (2026-04-21, working tree, uncommitted):** All 5 findings applied, ready for architect re-review.
- Finding #1 (P2 `active_accreditations` JOIN): `backend/src/routes/claims.ts` `isApprovedCoAuthor` SELECT now `FROM authorship_claims ac JOIN active_accreditations a ON a.account = ac.claimer` — revoked co-authors lose co-sign authority live.
- Finding #2 (P2 fragile mock SQL detection): `backend/tests/routes/claims.test.ts` pool-mock now branches on `sql.includes('FROM authorship_claims') && sql.includes("status = 'accepted'")` (multi-signal) — survives JOIN refactor from finding #1.
- Finding #3 (P2 HAF-throw fail-closed test): new scenario in approve describe — seeds COAUTHOR as approved, `queryFn.mockRejectedValueOnce(new Error('ECONNRESET'))`, asserts 403 FORBIDDEN AND `broadcastJson not.toHaveBeenCalled()`. Negative invariant: bridge key not used on HAF-throw.
- Finding #4 (P3 native-claimer-revoke symmetric test): new scenario in revoke describe — CLAIMER revokes own claim on native paper → 200 + returns operation + no server broadcast.
- Finding #5 (P3 chain-visible-actor comment): added at native-admin-revoke broadcast site in `claims.ts` noting the op is signed by admin, not the paper author.

---

### BE-ACCRED-TX-ID-PARITY — Add tx_id to GET /api/accreditations/:username (Backend Agent, P2)

**Status:** Implemented with **BE-ACCRED-REVOKE-TEST** (batched — same file). `backend/src/routes/accreditations.ts` `fetchAccreditationStatusFromHaf` SELECT now includes `cj.id AS event_id`; response projects `tx_id: result.rows[0].event_id?.toString() || null`. Shape mirrors `/api/profile/:username` exactly. New `backend/tests/routes/accreditations.test.ts` with a parity test asserting both endpoints return the same tx_id for a sample accredited account. 3/4 pass, 1 skipIf (the revoke-branch test — no `pevotest` account currently has `revoke` as its latest op in HAF; skip pattern mirrors the existing file).

**Review (CE) findings:** clean on the diff itself. Round-2 `/ce-code-review` surfaced 2 hardening items; see hold block below.

**Architect re-review (2026-04-21b) — HELD PENDING FIXES:**

1. **P2 — Revoke-branch skipIf chronically skips.** `backend/tests/routes/accreditations.test.ts:182-225` relies on `pevotest` HAF having an authority-signed `revoke` as the latest op for some account — no such account currently exists, so the test is aspirational coverage for the mutation-kill it claims to close. Fix: convert to mocked-pool carve-out per the CLAUDE.md clause. Mock `getPool()` for this one test, inject `{action: 'revoke', account: '...', ...}` as the latest row, assert `is_accredited: false` + `accreditation: null` + `tx_id: null`. Add a carve-out justification header to the test file (2-3 sentences, same form as `orcid.test.ts:6-15`). Keep the current skipIf real-HAF variant as a secondary test documenting the aspirational path.

2. **P2 — `|| null` vs `?? null` operator precision.** Change `event_id?.toString() || null` to `event_id?.toString() ?? null` at `backend/src/routes/accreditations.ts:143`. No current behavior change (HAF event_ids are always positive integers) but precise operator; future-proofs against falsy-non-null regressions if the column type ever widens. Pair with the identical change at `backend/src/routes/profile.ts:53` landing in the SEC-AUTH-BYPASS hold-pending-fixes block — same logical fix, two call sites.

**Dismissed from round-2 findings:** CTE duplication across 4 test scenarios (P3 — filing as follow-up when drift becomes visible is cheaper than a premature helper extraction).

**[TODO Architect]:** update `agents/docs/api-contracts/accreditation.md` `/:username` section to document `accreditation.tx_id: string | null` (the HAF event_id of the latest accredit custom_json). Mirror the prose + example already present for `/api/profile/:username`.

**Path to archive:** (1) Backend agent applies findings #9 + #10-accreditations-half in the test file + accreditations.ts. (2) Architect updates `accreditation.md` per [TODO Architect] note. (3) Re-review + atomic archive with BE-ACCRED-REVOKE-TEST.

**Backend re-review signal (2026-04-21, working tree, uncommitted):** Both findings applied, ready for architect re-review. Atomic pair with BE-ACCRED-REVOKE-TEST.
- Finding #9 (P2 revoke-branch mocked carve-out): `backend/tests/routes/accreditations-revoke.test.ts` (new, separate file so the mocks don't spill into the real-HAF specs in `accreditations.test.ts`). Mocks `getPool()` + `getRedis()`; injects `{action:'revoke', ...}` as the latest row for a unique username. Asserts `is_accredited:false` + `accreditation:null` + no `tx_id` leak. Carve-out justification header documents why real-HAF seed-and-wait is impractical. Existing skipIf real-HAF variant retained in `accreditations.test.ts` as the aspirational path.
- Finding #10 (P2 `?? null` operator precision): `backend/src/routes/accreditations.ts:143` changed from `|| null` to `?? null`. Companion change at `backend/src/routes/profile.ts:53` landed under SEC-AUTH-BYPASS (same logical fix, two call sites).

---

### BE-ACCRED-REVOKE-TEST — Revoke-branch test for fetchAccreditationStatusFromHaf (Backend Agent, P2)

**Status:** Implemented in the same commit as BE-ACCRED-TX-ID-PARITY. Revoke-branch skipIf test added in `backend/tests/routes/accreditations.test.ts`; currently skips because no `pevotest` HAF account matches the fixture. Closes the mutation-kill gap by design — when HAF has a matching account, the test will cover the revoke branch returning `is_accredited: false, accreditation: null`.

**Architect re-review (2026-04-21b) — HELD PENDING FIXES:**

See the BE-ACCRED-TX-ID-PARITY hold-pending-fixes block above — the revoke-branch carve-out conversion (round-2 finding #9) is batched with the tx_id work since both live in the same test file. This task archives atomically with BE-ACCRED-TX-ID-PARITY.

---

### SEC-004-BE — Make password optional for ORCID-verified signup/recover (Backend Agent)

**Status:** Landed on `main` at commit **2fd4d20** ("make password optional for ORCID-verified signup and recover (SEC-004-BE)") before this review pass. Verified in situ: `backend/src/routes/auth.ts` `/signup` and `/recover` accept null password on ORCID paths; `/login` returns `403 NO_PASSWORD_SET` when `password_hash IS NULL`; new `POST /api/settings/set-password` (400 weak / 401 unauthed / 404 no account / 409 PASSWORD_ALREADY_SET / 200 argon2id hash); `GET /api/settings/email` projects `has_password: boolean` (**snake_case**, settings.ts:91) with `has_password: false` fallback on no-row. `NO_PASSWORD_SET` + `PASSWORD_ALREADY_SET` added to `ErrorCode` in `backend/src/types/api.ts`. 46/46 tests pass across `signup-verify.test.ts`, `recover.test.ts`, `settings-set-password.test.ts`, `auth.test.ts`, `settings.test.ts` (real `verifyHiveSignature`, real Postgres, real Redis). Full backend suite: 221 pass + 3 skipIf across 34 files.

**Follow-ups from review triage (2026-04-21):**
- **C1** (6-way password-policy duplication) → filed as **BE-PASSWORD-POLICY-DRY** (backend) + **PASSWORD-POLICY-HARMONIZE** (cross-cutting FE+BE).
- **C2** (`/recover` silent branch-pick when both memo_key + orcid_token supplied) → **fixed in follow-up commit**: `auth.ts` now rejects with 400 "Supply exactly one of memo_key or orcid_token, not both". Test added in `recover.test.ts` validation block. 29/29 recover+settings tests pass.
- **C3** (trivial `hasPassword`/`verified`/`custody` locals in `settings.ts:81-83`) → **fixed in same follow-up commit**: inlined all three into the `sendOk` call for style consistency.

**Atomic-ship note:** SEC-004-BE and SEC-004-UI must ship together. SEC-004-UI is also in Review with 4 architect-flagged P0/P1 fixes outstanding (camelCase/snake_case field mismatch, resendVerification with empty password on ORCID branch, password-not-zeroed-on-error in handleSetPassword, dead `common.bip39NotLoaded` i18n key). Those are UI agent's to land before archiving either.

**[TODO Architect]:** verify the prose committed at 2fd4d20 for:
- `agents/docs/api-contracts/auth.md` — password optional on ORCID branch of `/signup` + `/recover`; new 403 `NO_PASSWORD_SET` on `/login`.
- `agents/docs/api-contracts/settings.md` (new file) — `POST /api/settings/set-password` schema + `has_password` (now renamed to `hasPassword` — see finding #4 below) on `GET /api/settings/email`.
- `agents/docs/api-contract.md` index — settings.md row + profiles.md description trim.

Also add the new C2 400 mutual-exclusion to `/recover` in auth.md.

**Architect re-review (2026-04-21b) — HELD PENDING FIXES:**

Round-2 `/ce-code-review` surfaced 7 findings. Must land before archive. SEC-004-BE + SEC-004-UI ship atomically (atomic-ship constraint preserved).

1. **P1 — Login enumeration oracle via null-hash short-circuit** (`backend/src/routes/auth.ts:~390`). Null-hash accounts return `403 NO_PASSWORD_SET` before `argon2.verify` runs, distinguishing ORCID-only accounts from normal accounts by status code AND response time (~1ms vs ~100ms). Unauthenticated attacker can enumerate ORCID-only PEvO users. Triaged to Option A (timing equalization only): run a sentinel `argon2.verify` against a fixed argon2id hash on the null-hash path before returning 403. Closes the timing axis; the 403 status-code axis remains as an accepted tradeoff — the feature-distinct error is UX-valuable for legitimate ORCID users, and status-code oracles are weaker than 100× timing gaps. Concrete shape: define `const SENTINEL_ARGON2_HASH` (real argon2id hash of a compile-time constant string, generated once); on the null-hash branch call `await argon2.verify(SENTINEL_ARGON2_HASH, password).catch(() => {})` before the 403 return. Add a unit test with a loose-bound wall-time assertion (e.g. null-hash path ≥ 50ms). Update the comment on `auth.ts:~399` ("Verify password first (before revealing account state)") to reflect the NO_PASSWORD_SET branch's new timing-equalized behavior (finding #7 batched in same edit).

2. **P2 — `/set-password` 404 leaks account deletion** (`backend/src/routes/settings.ts:~358`). Authed-but-deleted accounts hit 404 NOT_FOUND, distinguishable from 409 and 400 by a session holder. Fix: change to `sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid')`. Rationale: for authenticated endpoints, "your account no longer exists" ≡ "your session is no longer valid." Update the existing set-password test's 404 assertion to 401. **Plus (user triage A+B):** audit sibling authed endpoints that read `accounts` by username and apply the same 404 → 401 treatment where the pattern matches. Sites to check: `GET /api/settings/email` (settings.ts), `POST /api/settings/email`, `DELETE /api/settings/email`, any other authed accounts-by-username reader. Grep: `FROM accounts WHERE username` and `accounts WHERE username = $` across `backend/src/routes/`. Apply 401 treatment to each that currently returns 404 on missing-row for an authed request. Expected: +1-3 other call sites.

3. **P2 — `/set-password` lacks ORCID-verified guard.** The invariant "only ORCID-verified users can opt into password" is held implicitly (today, only ORCID-path signup/recover leaves `password_hash IS NULL`). Future flows that null the hash for other reasons would silently inherit set-password eligibility. Fix: add runtime guard after the existing null-hash check — `if (!account.orcid_id) return sendError(res, 403, 'ORCID_REQUIRED', 'Set-password requires a linked ORCID account')`. Add new `ORCID_REQUIRED` error code to `backend/src/types/api.ts`. Add one regression test: null-hash account without `orcid_id` → 403 ORCID_REQUIRED.

4. **P2 — Rename `has_password` → `hasPassword` end-to-end (backend half).** `GET /api/settings/email` currently emits `has_password` (snake_case) inside a response whose other keys are camelCase (`hasEmail`, `verified`, `pendingChange`, `custody`). Rename to `hasPassword` for internal consistency. Sites in `backend/src/routes/settings.ts`: 2 response sites, the `has_password: false` catch fallback. The frontend-half rename lands in SEC-004-UI's hold-pending-fixes. Collapses the `BE-SETTINGS-EMAIL-CASING` Pending task (removed in this pass).

5. **P3 — Mutation-kill assertion on C2 recover test.** `backend/tests/routes/recover.test.ts` C2 test (both `memo_key` + `orcid_token` → 400) asserts status + error code but not DB invariant. Add one assertion: post-request, the account's `password_hash` remained null. Guards against future refactors that reorder validation after DB access.

6. **P3 — Real argon2 hash as seed in set-password test.** `backend/tests/routes/settings-set-password.test.ts` seeds `password_hash: 'dummy-existing-hash'` for the 409 path. Works today because short-circuit bypasses `argon2.verify`. Swap to a real argon2id hash of a fixed known plaintext (e.g., pre-compute `await argon2.hash('known-test-password', { type: argon2.argon2id })` in a `beforeAll`) so future tests that exercise the verify path don't silently fail against a non-argon2 string.

7. **P3 — Comment drift on auth.ts:~399.** Batched into finding #1's edit. Sibling comment "Verify password first (before revealing account state)" is now misleading because the null-hash branch reveals state (via the new sentinel-verify delay) before the verify gate. Tighten to reflect the NO_PASSWORD_SET branch's timing-equalized behavior.

**Dismissed from round-2 findings:** "Supply exactly one of memo_key or orcid_token" error message "reveals server-side branching" (field names are API-contract visible — not an info leak); argon2 parameter lock (filed separately as **BE-ARGON2-PARAMETER-LOCK** P3 Pending task).

**[TODO Architect after fixes land] — doc updates:**
- `agents/docs/api-contracts/auth.md`: add an editorial note on `/login` timing-equalization behavior (advisory, not contract shape). Current C2 mutual-exclusion doc update happens now (see below).
- `agents/docs/api-contracts/settings.md`: rename `has_password` → `hasPassword` in `GET /email` response example; update `POST /set-password` error list to add `ORCID_REQUIRED` (403) and change `NOT_FOUND` → `UNAUTHORIZED` (401) on missing-account branch.
- `agents/docs/api-contract.md` index: verify settings.md + profiles.md rows are current.

**Path to archive:** (1) Backend agent applies findings 1-7 + the 404→401 audit sweep. (2) UI agent applies the `has_password` → `hasPassword` frontend rename (see SEC-004-UI hold-pending-fixes). (3) Architect updates the three api-contract files (deferred until post-fix). (4) Re-review with `/ce-code-review` + atomic archive of SEC-004-BE + SEC-004-UI.

**Backend re-review signal (2026-04-21, working tree, uncommitted):** All 7 backend findings + 404→401 audit applied. Atomic-ship constraint still requires SEC-004-UI's frontend `has_password` → `hasPassword` rename before either archives.
- Finding #1 (P1 login enumeration oracle): `backend/src/routes/auth.ts` now burns a sentinel `argon2.verify` against a module-load-computed `SENTINEL_ARGON2_HASH` on the NO_PASSWORD_SET branch before returning 403 — closes the 100× timing gap. Test: `recover.test.ts` "null-hash login burns sentinel argon2.verify for timing-equalization (≥ 50ms)" with loose CI-variance lower bound.
- Finding #2 (P2 404→401 sweep): `/set-password` + `DELETE /email` in `settings.ts`, `/custody/broadcast` + `/custody/upgrade` in `custody.ts` (4 sites total). `GET /email` already returned `hasEmail:false` fallback — left unchanged (legitimate Keychain-user-never-registered path). `settings.test.ts` DELETE-unknown-user expectation flipped to 401. New `settings-set-password.test.ts` 401 missing-row scenario.
- Finding #3 (P2 ORCID_REQUIRED guard): `/set-password` now selects `orcid` column, returns 403 `ORCID_REQUIRED` when null-hash row has no linked ORCID. New `ORCID_REQUIRED` error code in `backend/src/types/api.ts`. Regression test: null-hash account without orcid → 403 `ORCID_REQUIRED` + `password_hash` stays NULL.
- Finding #4 (P2 `has_password` → `hasPassword` backend half): `settings.ts` `GET /email` response key renamed at 2 sites + catch fallback. `settings-set-password.test.ts` flag-test assertions updated. Frontend half is UI agent's (see SEC-004-UI hold-pending-fixes).
- Finding #5 (P3 C2 mutation-kill): `recover.test.ts` new DB-backed scenario — seeds null-hash `NULL_USER`, sends both `memo_key` + `orcid_token`, asserts 400 VALIDATION_ERROR AND `password_hash` remained NULL post-request.
- Finding #6 (P3 real argon2 hash seed): `settings-set-password.test.ts` `beforeAll` now pre-computes `argon2.hash(EXISTING_PASSWORD, argon2id)` and seeds SET_USER with it; 409 assertion updated. Closes mutation surface for future refactors that exercise verify on the seeded hash.
- Finding #7 (P3 comment drift): `auth.ts` comment on the verify-password gate rewritten to reflect the NO_PASSWORD_SET branch's timing-equalized behavior.

**Test results:** Full backend vitest suite 230 passed + 3 skipped across 36 files. Targeted SEC-004-BE subset: 51 passed + 1 skipped across 7 files.

---

### SEC-004-UI — Stop persisting passwords across ORCID round-trip (UI Agent)

**Status:** Implemented, UI-side only. Unit tests 750/750 green (+17 SEC-004-UI tests across 4 files). `npm run build` clean. `/ce-work` stepped through the 5 actions; E2E spec written stubbed-first with 3 `test.fixme`s blocked on SEC-004-BE. **BLOCKER for archive: SEC-004-BE must land before this is safe to merge** — same atomic-ship constraint as SEC-002.

**Changes:**
- `frontend/src/pages/signup.js` — removed `password`/`passwordConfirm` from the `pevo_signup_draft` write in `handleOrcidVerify` and from the `init()` restore. Password + confirm fields hidden via `x-show="!orcidToken"`; added inline hint `signup.orcidNoPassword`. `canSubmit` drops password predicates on the ORCID branch. `handleSubmit` sends `password: null` on the ORCID branch (non-ORCID branch unchanged). Also tightened the DUPLICATE-fallback guard so it only runs when the non-ORCID branch has an actual password to retry with.
- `frontend/src/pages/recover.js` — same pattern: removed `newPassword`/`newPasswordConfirm` from the `pevo_recover_draft` write and init restore. Password fields hidden under `x-show="method !== 'orcid'"`; added `recover.orcidNoPassword` hint. `canSubmitOrcid` no longer requires password; submit path sends `new_password: null` when `method === 'orcid'`.
- `frontend/src/pages/settings.js` — added a "Set a password" surface gated on `emailStatus.hasPassword === false`. New state (`newPasswordInput`, `newPasswordConfirmInput`, `passwordSubmitting`, `passwordError`, `passwordSetDone`), new getters (`newPasswordValid`, `newPasswordsMatch`, `canSubmitPassword`) mirroring signup's validation, and a `handleSetPassword()` that calls the new API and flips `emailStatus.hasPassword` locally so the surface hides on success.
- `frontend/src/api.js` — new `setPassword(password)` helper posting to `/api/settings/set-password` via `authenticatedRequest`.
- `frontend/public/messages/en.json` — 3 new key groups: `signup.orcidNoPassword`, `recover.orcidNoPassword`, 9 `settings.setPassword*` keys.
- `frontend/public/messages/{ar,cs,da,de,es,fa,fr,he,it,nl,pl,pt,sv,tr,zh}.json` (15 files) — same 11 keys added to every locale with English source strings as TODO-placeholders per task instructions.
- `frontend/tests/unit/api.test.js` — +2 tests for `setPassword` (Bearer + UNAUTHORIZED).
- `frontend/tests/unit/pages-signup.test.js` — +5 tests covering the SEC-004 regression surface (no password in draft on OrcidVerify, legacy drafts do NOT rehydrate password, ORCID submit sends `password: null`, `canSubmit` semantics both branches).
- `frontend/tests/unit/pages-recover.test.js` — +5 tests mirroring the above for the recover flow.
- `frontend/tests/unit/pages-settings.test.js` — +6 tests covering `handleSetPassword` (happy path, invalid-password no-op, mismatch no-op, backend-error surface, `newPasswordsMatch`/`canSubmitPassword` getters).
- `frontend/tests/e2e/orcid-no-password.spec.js` (new) — 4 passing specs (2 for signup, 2 for recover) that stub `/api/orcid/start` + `/api/auth/{signup,recover}` at the network layer and assert draft localStorage + request bodies contain no password keys. 3 `test.fixme`s sketch the real-backend integration paths that become runnable once SEC-004-BE lands.

**Dependency on SEC-004-BE (BLOCKER for archive):** SEC-004-UI and SEC-004-BE ship atomically. Merging SEC-004-UI alone will cause the ORCID signup/recover submit paths to return 400 on today's backend (they still treat `password` as required). **Please do not archive SEC-004-UI in isolation.**

---

**Architect review (2026-04-21) — HELD PENDING FIXES:**

Task was architect-gated from archive pending SEC-004-BE. The review surfaced **P0 show-stopper defect** that makes the feature non-functional even when SEC-004-BE lands. Must fix these in the UI before archiving the atomic pair.

1. **P0 SHOW-STOPPER — `hasPassword` / `has_password` field-name mismatch.** Backend `GET /api/settings/email` emits `has_password` (snake_case, matching `backend/src/routes/settings.ts:91`). Template at `settings.js:168` reads `emailStatus.hasPassword === false` (camelCase). `undefined === false` → always false → **Set-Password surface never renders**. Entire SEC-004 opt-in is dead on arrival. Optimistic update spread at `settings.js:496` (`{ ...emailStatus, hasPassword: true }`) has the same wrong key. Unit tests hand-seed camelCase (`pages-settings.test.js:240`), **masking** the bug. Fix: (a) change template `emailStatus.has_password === false`; (b) change spread `has_password: true`; (c) add `has_password: false` to the catch fallback object in `loadEmailStatus` at `settings.js:451`; (d) update unit tests to seed `has_password` (snake_case). 2 reviewers cross-flagged (capped confidence).

2. **P1 — `handleResendVerification` passes empty password on ORCID branch.** After ORCID signup, `this.password=''`. Submitted screen still shows resend; calling `resendVerification(email, '')` likely errors on backend. Fix: either skip the resend button on ORCID branch (hide with `x-show="!orcidToken"`) OR make resendVerification password-optional when there is no password.

3. **P1 — Password not zeroed on error path in `handleSetPassword`.** `settings.js:498` catch block doesn't zero `newPasswordInput` / `newPasswordConfirmInput` → plaintext password remains readable in Alpine reactive state via XSS for the error-display duration. Same class as FE-UPGRADE-CREDENTIAL-WIPE. Fix: add `this.newPasswordInput = ''; this.newPasswordConfirmInput = '';` at the top of the catch block.

4. **P1 — Dead i18n key `common.bip39NotLoaded` in all 16 locale files.** SEC-004-UI's `settings.js` change removed the `_getBip39()` method that referenced this key; FE-UPGRADE-KEY-WRAPPER-ADOPT was going to clean it, but the prerequisite code is already gone NOW. Delete the key from all 16 `frontend/public/messages/*.json`.

**P2/P3 items (batched into FE-SEC-004-POLISH Pending — NOT required to land before archive):**
- `pevo_signup_orcid_name` orphaned in localStorage
- `handleSetPassword` mutation-order fragility
- Overlapping `passwordSetDone` + `emailStatus` signals (collapse after field-name fix lands)
- E2E spec Alpine-internals reach (`_x_dataStack[0]`)
- Brittle `button[@click=...]` selector
- `handleSetPassword` double-guard path untested
- Task-ID refs in comments
- Placeholder-translation markers for 15 locales

**P1 separate follow-up — FE-PASSWORD-POLICY-DRY:** rule `length >= 10 && /[a-z]/ && /[A-Z]/ && /[0-9]/` duplicated across `signup.js`, `recover.js`, `settings.js`, `reset-password.js`. Extract `frontend/src/password-policy.js`. Filed as Pending.

**Path to archive:** (1) UI agent fixes the 4 must-fix items above in a commit on top of SEC-004-UI. (2) SEC-004-BE lands. (3) Atomic ship — archive both together. Review artifact: `.context/compound-engineering/ce-code-review/20260421-122144-98977b64-sec-004-ui/`.

---

**Architect re-review (2026-04-21b) — ORIGINAL HOLD RESOLVED + ONE NEW FIX:**

All 4 items held on 2026-04-21 are FIXED in the working-tree follow-up:

- ✅ `has_password` (snake_case) consistently applied at template (`settings.js:168`), catch fallback (`:451`), optimistic spread (`:496`), delete-path reset (`:517`). Unit tests seed snake_case.
- ✅ `handleResendVerification` guards on ORCID branch — template `x-show="!resendSuccess && !orcidToken"` + handler `if (this.isResending || this.orcidToken) return`. Regression test at `pages-signup.test.js:321-329`.
- ✅ `handleSetPassword` catch zeroes both `newPasswordInput` + `newPasswordConfirmInput` before surfacing error. Regression test at `pages-settings.test.js:283-292`.
- ✅ `common.bip39NotLoaded` deleted from all 16 locale files. Grep confirms zero remaining references in `frontend/`.

Round-2 `/ce-code-review` surfaced **one new finding** that partners with SEC-004-BE finding #4:

1. **P2 — Rename `has_password` → `hasPassword` end-to-end (frontend half).** SEC-004-BE is renaming the backend response field from `has_password` (snake_case) to `hasPassword` (camelCase) to restore internal consistency with the rest of the `GET /api/settings/email` response object. Frontend must rename symmetrically — and this must ship in the same atomic pair. Sites:
   - `frontend/src/pages/settings.js`: template at line 168 (`emailStatus.has_password === false` → `emailStatus.hasPassword === false`), `loadEmailStatus` catch fallback (~451), `handleSetPassword` optimistic spread (~496), `handleEmailDelete` reset (~517). Four sites.
   - `frontend/tests/unit/pages-settings.test.js`: ~5 seed/assertion sites. Swap from snake_case to camelCase.

   Collapses the `BE-SETTINGS-EMAIL-CASING` Pending task (removed in this pass).

**Path to archive:** SEC-004-BE's 7 fixes land → SEC-004-UI's 1 rename lands → architect re-reviews once → atomic archive of both.

**UI re-review signal (2026-04-21, commit `e257047`):** All 4 round-1 must-fix items + the round-2 `hasPassword` rename finding are FIXED.
- ✅ Round-1 #1 (`hasPassword`/`has_password` mismatch, dead-on-arrival) + round-2 #1 (end-to-end camelCase rename): `frontend/src/pages/settings.js` 4 sites renamed to `hasPassword` (template:168, catch fallback:451, optimistic spread:496, `handleEmailDelete`:517). `frontend/tests/unit/pages-settings.test.js` 7 seeds updated to camelCase. Atomic-ship partner for SEC-004-BE round-2 finding #4.
- ✅ Round-1 #2 (empty-password resend on ORCID branch): `signup.js:150` template hide `x-show="!resendSuccess && !orcidToken"` + `handleResendVerification` handler guard. Regression test `pages-signup.test.js:323-330`.
- ✅ Round-1 #3 (password not zeroed on `handleSetPassword` error): `settings.js:501-502` zeroes `newPasswordInput` + `newPasswordConfirmInput` at top of catch block.
- ✅ Round-1 #4 (dead `common.bip39NotLoaded`): removed from all 16 `frontend/public/messages/*.json`. Grep confirms zero references.

**Test results:** 832/832 unit tests pass at session end. `npm run build` clean.

---

### SEC-002-HARDENING — Post-review hardening of /api/orcid (Backend Agent, P2)

**Status:** All 6 items landed at commit **0e4241b** ("harden /api/orcid state consume, envelope, TOCTOU cache, prod warn (SEC-002-HARDENING)"). 14/14 `orcid.test.ts` pass (9 pre-existing SEC-002-BE + 5 new hardening). Full backend vitest 239 pass + 1 skipped; 2 `hafsql.test.ts` ECONNRESETs under concurrency, pass in isolation (infra flap, unrelated to this commit).

- **#1 state-consume inside try/catch** — `backend/src/routes/orcid.ts:185-194`. `redis.del`/`orcidStates.delete` now sits inside the outer try wrapping the token-exchange dispatch; a Redis DEL throw maps to 500 via the existing catch. Did NOT use `redis.getdel` — would break #3's state-not-consumed-on-403 contract.
- **#2 NO_ACCOUNT envelope fix** — `handleLogin` now emits `sendError(res, 404, 'NO_ACCOUNT', '...', { orcid_id })` so the frontend `ApiRequestError` parser receives `orcid_id` under `error.details`. Required adding `details?: Record<string, unknown>` to the `ApiError.error` shape in `backend/src/types/api.ts` and a `details` parameter on `sendError` in `backend/src/response.ts`.
- **#3 state-not-consumed-on-403 contract** — code-side contract enforced by the #1 move (consume fires only when auth passes). See **[TODO Architect]** below for the orcid.md prose.
- **#4 `orcid-link.spec.js:107-115` test.fixme** — implemented the two-browser-contexts 403 test (`frontend/tests/e2e/orcid-link.spec.js:107-176`); hits the API directly across two `browser.newContext()`s, asserts 403 FORBIDDEN. Falls back to `test.skip` with a concrete citation when ORCID is unconfigured in the test environment.
- **#5 HAF-lag TOCTOU mitigation** — `${config.appTag}:orcid_binding:${orcid_id}` EX 120s/value=username, written after the successful broadcast in both `handleAccredit` and `handleLink`. `findAccreditedAccountWithOrcid` consults Redis first and short-circuits when `value !== candidateUsername`. Redis outage degrades gracefully (falls back to the HAF-only path).
- **#6 production multi-process startup check** — new `backend/src/startup-checks.ts` `checkOrcidProcessSafety()`, wired from `backend/src/index.ts` post-listen. Fires a loud `logger.warn` 5s after boot under `NODE_ENV=production` when Redis is not ready, calling out single-process-only `orcidStates` fallback as a multi-process/PM2/clustered-deploy breakage risk.

**[TODO Architect]** — `agents/docs/api-contracts/orcid.md`:
1. Under `POST /api/orcid/callback`, document the state-not-consumed-on-403 contract (item #3): "On a 403 FORBIDDEN response from authenticated modes (caller username does not match the initiator stored at /start), the OAuth `state` parameter is intentionally NOT consumed. The legitimate initiator can retry `/callback` with a valid bearer without being forced back through the ORCID OAuth redirect. State is consumed only after auth passes, or after any success or error on unauthenticated modes."
2. Update the NO_ACCOUNT response example (item #2): `orcid_id` now lives under `error.details`, not at the top level. Shape: `{ "status": "error", "error": { "code": "NO_ACCOUNT", "message": "...", "details": { "orcid_id": "0000-..." } } }`.
3. Consider adding a one-line note in `common.md` documenting that `error.details` is the canonical channel for error-context fields (mirrors the generic `ApiError.error` shape change in `backend/src/types/api.ts`).

**Downstream follow-up (UI agent territory, not blocking this task):** `ApiRequestError` on the frontend should consume `error.details` alongside whatever it reads today. Current `orcid-callback.js` didn't appear to use the old top-level `orcid_id`, so the move is likely inert — but worth a grep pass across `frontend/src/**` before the contract ships.

---

### BE-CLAIMS-ERROR-POLISH — Surface bridge misconfiguration with a distinct 503 (Backend Agent, P3)

**Status:** Landed at commit **1cec6df** ("surface bridge misconfig with 503 (BE-CLAIMS-ERROR-POLISH)"). 16/16 `claims.test.ts` pass (13 pre-existing + 3 new BE-CLAIMS scenarios).

- **claims.ts:194-196** (approve handler): new guard `if (paperAuthor === config.hiveBridgeAccount && !config.pevoBridgePostingKey) return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Bridge posting key not configured')`, placed immediately before the bridge-branch auth check so operators see a dedicated 503 instead of the misleading "Only the post author can approve claims on native papers" fall-through.
- **claims.ts:290-292** (revoke handler): same guard, placed **after** basic authorization (isPostAuthor/isClaimer/isAdmin) so unrelated callers still see 403 FORBIDDEN first; the 503 fires only for authorized callers on bridge papers with no posting key. Spec line numbers (~190/~277) drifted to 194/290 after the SEC-003-BE round-2 `active_accreditations` JOIN + chain-visible-actor comment.
- **`backend/tests/routes/claims.test.ts`** — new `describe('BE-CLAIMS-ERROR-POLISH — bridge misconfig surfaces as 503')` block (3 scenarios: approve 503, revoke 503 from admin, no `broadcastJson` in either case). Per-test save/restore of `config.pevoBridgePostingKey` via `afterEach`.

No contract change required (shape is a generic `SERVICE_UNAVAILABLE` 503, fits the existing envelope).

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

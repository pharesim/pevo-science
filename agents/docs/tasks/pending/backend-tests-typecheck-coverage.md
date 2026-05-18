# BACKEND-TESTS-TYPECHECK-COVERAGE — Extend `tsc --noEmit` over `backend/tests/` and patch `LogContext` typo-bypass sites

**Owner:** backend
**Created:** 2026-05-11 (architect, batch-1 review triage of broadcast-idempotency cluster round-2)
**Priority:** P1

## Context

The `LogContext` interface at `backend/src/lib/broadcast-error.ts:114` was introduced specifically to catch typo-field calls at compile time. The inline comment captures the design intent: *"a typo at a call site compiles silently and operators got an inconsistent log shape."* The interface declares fields like `username?: string`, and excess-property checking on src/ call sites SHOULD reject `{ usrname: 'alice' }` or `{ user: 'alice' }` at compile time.

But two architect batch-1 reviewers (kieran-typescript KT-1 + maintainability M3, cross-reviewer confidence 100) found that the test file `backend/tests/lib/broadcast-error.test.ts` passes invented fields directly:
- Line 34: `{ user: 'alice', action: 'test' }` (LogContext declares `username`, not `user`; `action` doesn't exist at all)
- Line 69: similar
- Lines 258, 300, 362, 465, 523, 552, 752, 772, 790: similar patterns with invented keys like `case`, `run`, `case-b`, etc.

These compile because:
1. **`backend/tsconfig.json` has `include: ['src']`** (line 15) — `tests/` is excluded from tsc.
2. **Vitest uses esbuild**, which strips types without enforcing excess-property checks.

The tests then ASSERT that the typo'd key surfaces in the log output:
```ts
expect(call.user).toBe('alice');   // 'user' is not in LogContext; 'username' is
```

This codifies the bypass as expected behavior. A real production caller writing `logContext: { usrname: 'alice' }` would silently slip through with no compile error and produce an inconsistently-typed log — exactly the failure mode the interface was added to prevent. The test suite is documenting a wrong contract.

The right structural fix is to bring `tests/` under tsc coverage, then either fix the test cases that use invalid keys OR introduce an explicit `TestLogContext = LogContext & Record<string, unknown>` cast at sites where arbitrary extra keys are intentional (e.g., where a test deliberately exercises the spread-through behavior). The structural fix also catches any FUTURE drift in the test suite — not just the ~11 cited sites.

## Acceptance

1. **Add `backend/tests/tsconfig.json` extending the root tsconfig with `tests/` included.** Shape (subject to project conventions):
   ```json
   {
     "extends": "./tsconfig.json",
     "include": ["src", "tests"]
   }
   ```
   Place it at `backend/tests/tsconfig.json` (or `backend/tsconfig.tests.json` if the project prefers that convention; check existing patterns).
2. **Run `tsc --noEmit -p backend/tests/tsconfig.json`** and surface every error. Expected: ~11 errors in `broadcast-error.test.ts` at the cited line range, possibly more in other test files that have drifted similarly.
3. **For each error, decide between two fixes per case:**
   - **Fix the test:** if the test is asserting on a field that SHOULD be in `LogContext` (e.g., `user` → `username`), update the test to use the correct field name. The test's intent was to pin the log shape; using the correct name preserves that.
   - **Introduce a cast:** if the test is deliberately exercising the "extra keys spread through" behavior (e.g., a test asserting that `LogContext` callers can pass arbitrary structured-log fields), introduce a `TestLogContext = LogContext & Record<string, unknown>` type or `as unknown as LogContext` cast at the specific call sites. Prefer fixing-the-test over casting unless the deliberate-spread is genuinely the test intent.
   Document the choice per site in a brief comment when casting (the cast itself is a signal; the comment explains why a cast was the right call for THIS site).
4. **Wire the test-tsconfig check into CI / lint.** Add a script to `package.json` (e.g., `"typecheck:tests": "tsc --noEmit -p tests/tsconfig.json"`) and run it alongside the existing `typecheck` script. Document in `agents/backend/CLAUDE.md` if the convention needs an anchor for future test additions.

   **Round-1 hold amendment (2026-05-16, path (b) defer-and-document).** The original "ALONGSIDE" wording is preserved above as the record-of-intent, but its second clause (chaining `typecheck:tests` into `typecheck` so a single `npm run typecheck` invocation runs both) is **superseded** by the deferred follow-up task `agents/docs/tasks/pending/backend-tests-typecheck-residual-drift.md`. Chaining today would block every commit on 249 pre-existing tsc errors across 56 test files (broadcast-error.test.ts itself is clean — the noise is everywhere else). What this task delivers: the standalone `typecheck:tests` npm script (already in `package.json`), the structural `backend/tests/tsconfig.json`, and the LogContext typo-bypass fix in `broadcast-error.test.ts`. What the follow-up delivers: the 249-error backlog triage + the final chaining step gated on the backlog clearing. See round-1 hold item 1 below for the path (a) vs path (b) framing.
5. **Spot-check that the structural fix actually catches the original class.** After the work lands, write one quick test case that uses a typo'd LogContext field (`{ usrname: 'alice' }`); confirm the typecheck step fails on it; then remove the case (the test exists only as a verification that the structural check works).

## Tests

The typecheck step itself is the test. No new unit specs are required beyond the spot-check above. The act of adding the tests-tsconfig + fixing the cited sites is mutation-checked by the next typecheck run.

## Out of scope

- Adding tsc coverage to `frontend/tests/` (parallel concern but UI agent's call).
- Refactoring `LogContext` itself or any of its production call sites in `backend/src/`. The interface is correct; only test sites bypass it.
- Catch-all `Record<string, unknown>` typing on `LogContext` itself. The whole point is that excess properties at production call sites should be caught.

## References

- Architect batch-1 review findings KT-1 (kieran-typescript) + M3 (maintainability). Cross-reviewer corroboration; confidence 100.
- `LogContext` interface: `backend/src/lib/broadcast-error.ts:109-178`. Inline comment at line 109-111 captures the rationale: *"a typo at a call site compiles silently and operators got an inconsistent log shape."*

## Priority rationale

P1 because the test suite is wire-asserting a contract violation, and the LogContext interface's typo-protection is load-bearing for operator log shape consistency. Single-file patch (option for case-by-case fixes) is feasible, but the structural fix (tests-tsconfig) is preferred because it ALSO catches future test-file drift, not just the cited sites today.

---

## Architect re-review (2026-05-16) — HELD PENDING FIXES (round 1)

`/ce-code-review` on commit `c90d890` dispatched 6 reviewers (correctness on Opus; testing, maintainability, project-standards, kieran-typescript, ce-learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). The task file in `tasks/review/` had no `## Backend re-review signal` block — commit `c90d890` is the implementer commit per the `6526dd1` body. User-triaged 2026-05-16. Three items held below; architect-zone carry-forward listed separately for archive; other findings dismissed at triage.

The implementation lands the tests-tsconfig + `typecheck:tests` script and fixes the 12 cited LogContext typo-bypass sites in `broadcast-error.test.ts`. The structural intent (catch typo'd discipline-interface fields under tsc) is met for that file. Items 1 + 2 are the substantive contract-completeness concerns; item 3 is a small TypeScript-correctness improvement at the adversarial-fixture cast sites.

The implementer's commit scope-down ("~250 additional errors across other test files NOT fixed; `typecheck:tests` intentionally NOT chained to `typecheck`") is author-noted in the commit message but contradicts Acceptance #4's "ALONGSIDE" wording and creates a gate that cannot function as a regression net today. Item 1 forces a choice between fix-and-chain vs defer-and-document.

### Items to address

#### P1 — high

**1. (P1) Acceptance #4 "ALONGSIDE" unmet AND `typecheck:tests` cannot function as a regression gate today (combined item 9 + 12).**

**Where:** `backend/package.json:16-17` (the two-script structure) + the 249-error pre-existing-drift state of `npm run typecheck:tests`.

**Why:** Cross-corroborated at conf 100 by testing T1 (medium/conf 90), testing T2 (medium/conf 85), project-standards PS-2 (P1/conf 85). Acceptance #4 reads: "Wire the test-tsconfig check into CI / lint. Add a script to package.json (e.g., `typecheck:tests`) and run it alongside the existing typecheck script." The commit added the script as a standalone command — `npm run typecheck` does NOT fan out to `typecheck:tests`. Verified at HEAD: `npm run typecheck:tests` exits non-zero with 249 errors across 56 files. The gate cannot detect a new LogContext typo against the noise floor today, and the canonical pre-merge check (`npm run typecheck`) does not run it at all. The typo-protection contract is partial-rollout — protected for `broadcast-error.test.ts` only, blind everywhere else.

**Fix:** the implementer chooses ONE of:

- **(a) Fix-and-chain.** Clear the 249-error baseline (per Acceptance #2's "surface every error" — original intent was to fix all of them, not just the LogContext class) and chain `typecheck:tests` into `typecheck` so the canonical command catches both. Larger scope but delivers the acceptance criterion as written.
- **(b) Defer-and-document.** Keep the scope-down BUT (i) file a follow-up task `backend-tests-typecheck-residual-drift.md` under `tasks/pending/` listing the 249-error backlog with a triage approach (categorize errors, decide which to fix vs `@ts-expect-error`, decide whether to add per-file tsconfig excludes), AND (ii) update this task's body Acceptance #4 to acknowledge the scope-down with a cross-reference to the new follow-up task. The "ALONGSIDE" wording either gets rewritten or the chained behavior is added as a separate step gated on the backlog clearing.

Either path closes the contract gap. Path (a) is structurally cleaner but expensive; path (b) is realistic given the backlog size.

**2. (P1) `TestLogContext = LogContext & Record<string, unknown>` widens the type contract at 5 callsites — typos at those sites compile silently.**

**Where:** `backend/tests/lib/broadcast-error.test.ts:24` (type definition) + 5 callsites using `as TestLogContext`.

**Why:** Kieran-typescript KT-1 (P1/conf 75). The whole point of `LogContext` is excess-property checking. `& Record<string, unknown>` reopens the bypass at every `as TestLogContext` site — a typo like `{ rn: 'event-pin-timeout' }` (typo of `run`) passes tsc silently. The docblock at line 15 justifies the cast as "reserved for tests that deliberately exercise the extra keys spread through behavior", but the structured-log assertions only catch the typo if the typo'd key happens to be the one asserted in `objectContaining({...})`. A future author adding a new debug marker via the cast pattern without asserting it slips past both tsc AND runtime.

**Fix:** the implementer chooses ONE of:

- **(a) Add `run?: string` (and any other real debug-marker fields) directly to `LogContext`.** The `run` discriminator IS a real structured-log field operators see — making it a declared optional field is honest about what it is and restores excess-property checking at the cast callsites. Remove `TestLogContext` entirely.
- **(b) Stop routing debug discriminators through `logContext`.** Store the spec discriminator in a JS-scope local variable and reference it directly in the `expect().objectContaining({...})` assertion. The runtime assertion still pins that the helper spreads the right fields; the test just doesn't fake one of those fields through the contract. Remove `TestLogContext`.
- **(c) Rename `TestLogContext` to `DebugMarkerLogContext`** AND sharpen the docblock to state the two-pattern boundary (this type is for debug-marker fields ASSERTED in structured-log expectations; `as unknown as Parameters<typeof handleBroadcastError>[2]` is for opts-level adversarial keys). Less invasive but preserves the type-widening backdoor.

Architect preference: (a) or (b). (c) is acceptable if the implementer has a strong case for keeping the cast pattern.

#### P2 — moderate

**3. (P2) `Parameters<typeof handleBroadcastError>[2]` cast is fragile structural query; use exported `HandleBroadcastErrorOpts` directly.**

**Where:** `backend/tests/lib/broadcast-error.test.ts:215, 624, 661, 731` (4 sites: 3 adversarial spread-kill fixtures from this commit + 1 pre-existing round-5 hold #1 site).

**Why:** Kieran-typescript KT-2 (P2/conf 75). `HandleBroadcastErrorOpts` is already exported from `backend/src/lib/broadcast-error.ts:338`. The `Parameters<typeof>[2]` form is a structural query into the function signature — if the signature gains a leading parameter or shuffles, the index silently shifts and the cast targets the wrong type. The named-type form is strictly more robust: the name survives signature refactors, grep finds all cast sites, the intent is explicit.

**Fix:** add `type HandleBroadcastErrorOpts` to the import block at lines 3-11 and replace all 4 occurrences of `as unknown as Parameters<typeof handleBroadcastError>[2]` with `as unknown as HandleBroadcastErrorOpts`.

### Architect-zone carry-forward (no implementer action; architect lands at archive)

- **agents/backend/CLAUDE.md anchor for the TestLogContext / type-cast convention.** Task Acceptance #4 included "Document in agents/backend/CLAUDE.md if the convention needs an anchor for future test additions." The commit's docblock + this hold block describe the convention well; once the implementer lands item 2 (whatever form), the convention is stable enough to anchor in the agent protocol. Architect lands at archive — the surviving cast pattern (whichever option (a)/(b)/(c) the implementer picks) becomes the canonical reference.

### Findings dismissed at triage (no action)

- **(project-standards PS-1)** missing Backend re-review signal block: process gap; commit `c90d890` is traceable via `6526dd1` body. Noted for future-task discipline.
- **(maintainability M1)** TestLogContext naming/docblock sharpness: subsumed by item 2 (whichever rename/restructure path the implementer picks resolves M1 too).
- **(maintainability M2)** two parallel script names without documented convergence intent: subsumed by item 1's resolution.
- **(kieran-typescript KT-3)** `rootDir:".."` produces backend-relative error paths: cosmetic, no behavioral risk.
- **(kieran-typescript KT-4)** `include:["../src",...]` extends-replaces trap: cosmetic.
- **(testing T4)** TestLogContext spread guardrail: preemptive per memory `feedback_dismiss_preemptive_test_hardening` (no current misuse).
- **(project-standards PS-5)** spot-check verification verbal-only: Acceptance #5 EXPLICITLY required removal of the canary case. Verbal verification is the criterion as written.
- **(correctness #5)** `types:["node"]` excludes vitest globals: non-issue for the in-scope file, subsumed by the 249-error follow-up.

### Re-review signal

When items 1, 2, 3 land (path-of-resolution recorded in the re-review signal block), `git mv` this file from `tasks/pending/` back to `tasks/review/`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. The architect's next review pass scopes `/ce-code-review` to commits since `c90d890`. Items 1, 2, 3 are independent and can fan out in separate commits; item 1 may itself fan into multiple commits if path (a) (fix the 249 errors) is chosen.

## Backend re-review signal (2026-05-16, round-1 → round-2 fix commit)

Round-1 hold items P1 #1, P1 #2, P2 #3 landed.

**Item 1 (P1) — Path (b) defer-and-document chosen.** Filed follow-up `agents/docs/tasks/pending/backend-tests-typecheck-residual-drift.md` capturing the 249-error baseline + a per-category triage approach (A: real drift fix, B: type-import fix, C: vitest-globals tsconfig decision, D: wot-broadcast top-level-await TS1309, E: fixture-mock-shape, F: per-file exclude with rationale) + chaining intent (chain `typecheck:tests` into `typecheck` once the backlog clears, plus spot-check). Updated Acceptance #4 body in this task file with a round-1 hold amendment cross-referencing the follow-up; original "ALONGSIDE" wording is preserved above the amendment as the record-of-intent. `typecheck:tests` remains standalone in `backend/package.json` (no change to the script structure); chaining into `typecheck` is gated on the follow-up.

**Item 2 (P1) — Path (a) chosen (declare `run?: string` on `LogContext`).** All 5 `as TestLogContext` cast sites in `broadcast-error.test.ts` passed only `{ run: '<spec-id>' }` — never `case`, `case-b`, or any other test-only scaffolding field. `run` IS a real structured-log marker that operators see in production payloads (the helper spreads it through alongside `event:`/`err:`/etc), so promoting it to a declared optional field on `LogContext` is honest about what the field is. Changes:

- `backend/src/lib/broadcast-error.ts`: added `run?: string` as the last declared field on `LogContext` with a docblock explaining the path-(a) promotion and pointing to this task.
- `backend/tests/lib/broadcast-error.test.ts`: removed the `TestLogContext = LogContext & Record<string, unknown>` type alias entirely; updated the header comment to document the path-(a) rationale and the surviving cast pattern for adversarial fixtures; updated all 5 cast sites (lines 452, 558, 862, 883, 902 in the pre-edit file) to pass `{ run: '<spec-id>' }` as plain `LogContext` (no widening cast, full excess-property checking restored). Inline per-site comments simplified from "test-only per-spec discriminator (not a real LogContext field)" to "Per-spec discriminator (`run` is a declared optional `LogContext` field)".

**Item 3 (P2).** Replaced **5** `as unknown as Parameters<typeof handleBroadcastError>[2]` casts with `as unknown as HandleBroadcastErrorOpts` (named-type form imported from `backend/src/lib/broadcast-error.ts:338`). The hold block cited 4 sites (lines ~215, 624, 661, 731); inspection at HEAD on commit `c90d890` shows 5 actual occurrences (round-2 type-bypass regression guard at ~219, round-4 hold #1 spread-kill pair at ~629 + ~666, round-5 hold #1 spread-kill pair at ~736 + ~804). Replaced all 5 plus the inline comment reference. The named-type form is robust against signature refactors (the structural `Parameters<typeof>[2]` index silently shifts if the function gains a leading parameter); `HandleBroadcastErrorOpts` is greppable across the suite.

**Verification:**

- `cd backend && npx tsc --noEmit -p tsconfig.json` → clean (root tsc covers only `src/`; the `run?: string` addition to `LogContext` is additive and doesn't break any of the 17+ production call sites that pass `LogContext` literals).
- `cd backend && npx tsc --noEmit -p tests/tsconfig.json` → **249 errors before** (baseline on commit `c90d890`), **249 errors after** (delta 0). The fix is structurally additive: `LogContext` gained one optional field, and `broadcast-error.test.ts` was already clean at HEAD (0 of the 249 errors were in this file — the typo-bypass sites compiled silently under the pre-task tsconfig, but `broadcast-error.test.ts` itself remained tsc-clean even after the tests-tsconfig was added in commit `c90d890`). The 249-error backlog is pre-existing drift in 56 OTHER test files; clearing it is deferred to the follow-up.
- `cd backend && npm run lint` → clean (2 pre-existing warnings in `src/seed-phrase.ts:26,27`, unrelated).
- `cd backend && npx vitest run tests/lib/broadcast-error.test.ts` → **42/42 tests pass**.
- Gate 5 (`grep -n "as TestLogContext\|TestLogContext =" backend/tests/lib/broadcast-error.test.ts`) → **0 matches** (after rewording the documentary comment to avoid the false-trigger pattern).
- Gate 6 (`grep -n "Parameters<typeof handleBroadcastError>\[2\]" backend/tests/lib/broadcast-error.test.ts`) → **0 matches**.
- Gate 7 (`grep -n "HandleBroadcastErrorOpts" backend/tests/lib/broadcast-error.test.ts`) → **9 matches** (1 import + 5 cast sites + 3 documentary comment references).
- Gate 8: new follow-up task file at `agents/docs/tasks/pending/backend-tests-typecheck-residual-drift.md` filed with the standard task-file shape (heading + Owner/Created/Priority + Problem + Why path (b) + Acceptance + Tests + Out of scope + References + Priority rationale).

---

## Architect re-review (2026-05-18) — HELD PENDING FIXES (round 2)

`/ce-code-review` on commit `2c34341` with 7 personas (correctness on Opus; testing/maintainability/project-standards/kieran-typescript/reliability/learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md). Round-1 acceptance verified: path-(b) defer-and-document filed `backend-tests-typecheck-residual-drift.md` follow-up + updated Acceptance #4 amendment; `run?: string` promoted to `LogContext` interface declaration; 5 `as TestLogContext` cast sites migrated to plain `LogContext` literals; 5 `Parameters<typeof handleBroadcastError>[2]` casts replaced with `HandleBroadcastErrorOpts` named-type form. 42/42 vitest pass. User-triaged 2026-05-18; 3 comment-anchor-hygiene items held below.

### Items held (must fix before archive)

1. **(P2 kieran-typescript+maintainability+learnings, cross-reviewer anchor 100)** Task-slug citation in production `LogContext.run` docblock at `backend/src/lib/broadcast-error.ts:295`. The docblock opens with "Backend-tests-typecheck-coverage round-1 hold item 2 (path (a)):" and ends with "See the task file for the alternative paths (b) and (c) that were dismissed." Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, task-slug citations in production code go stale on archive and the "See the task file" redirect becomes a dead pointer (archive truncates from the bottom at 250 lines so older entries fall off entirely).

   Fix: rewrite the docblock with behavioral semantics only. Suggested shape: a per-attempt correlator that operators can set to correlate sibling structured-log entries; the helper spreads it through alongside `event:`/`err:`/etc. Drop the task slug and the "See the task file" redirect. Keep the behavioral description.

2. **(P2 maintainability M1, anchor 75)** Task-slug citation in test file header at `backend/tests/lib/broadcast-error.test.ts:15`. Same convention violation as item 1, different file. The test header cites `backend-tests-typecheck-coverage` by slug. Behavioral fallback exists (`LogContext.run` docblock anchor), so the damage is more limited than item 1, but the slug still rots on archive.

   Fix: drop the slug citation; keep the behavioral description (or replace the slug with a one-line description of what the test header is actually documenting).

3. **(P3 correctness residual, anchor 75)** Cosmetic comment-vs-code drift at `backend/tests/lib/broadcast-error.test.ts:618, :840`. Both inline comments describe the cast at the site as `as unknown as Parameters<typeof handleBroadcastError>[2]` while the actual code at those sites now uses `as unknown as HandleBroadcastErrorOpts` (item 3 of round-1 already migrated the casts).

   Fix: update both inline comments to describe the cast as `as unknown as HandleBroadcastErrorOpts`.

### Items dismissed during architect triage (recorded for transparency)

- (P2 maintainability M1, anchor 75) `run` field name under-descriptive on production interface — dismissed: architect explicitly endorsed `run` in the round-1 hold's path-(a) prescription ("`run` IS a real structured-log marker that operators see in production payloads"); re-litigating settled naming after the implementer landed it verbatim per the round-1 hold text is process churn. Rename if a real production caller surfaces a problem.
- (P3 testing TG-1, anchor 75) Round-1 signal block lacks verbal verification sentence for Acceptance #5 spot-check — dismissed: tsc-clean exit-zero implies the structural gate works; PS-5 was already explicitly dismissed in round-1 ("Acceptance #5 EXPLICITLY required removal of the canary case. Verbal verification is the criterion as written.").
- (P3 kieran-typescript residual) 9 `Parameters<typeof makeLogBroadcastAttempt>[2]` casts remain in same test file at ~lines 949-1192 — handed to separate architect action (filed as new task `backend-makelogbroadcastattempt-cast-narrow.md` for cluster-D follow-up).

### Items handed to separate architect actions (still on the architect's backlog)

- (Architect carry-forward, cluster-D) Convention-recurrence: surface `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15` and `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15` in `agents/backend/CLAUDE.md` so they reach implementer write-time context per `conventions-in-solutions-dont-reach-implementer-context-2026-05-18.md`. Lands in a separate architect commit during cluster archive.
- (Architect carry-forward, cluster-D) 9 `Parameters<typeof makeLogBroadcastAttempt>[2]` casts in `backend/tests/lib/broadcast-error.test.ts:~949-1192` — filed as new `backend-makelogbroadcastattempt-cast-narrow.md` follow-up task.

### Re-review signal

When items 1–3 land, `git mv` this file back to `tasks/review/`. Round-3 architect re-review scopes `/ce-code-review` to commits since `2c34341`. Anchor: 3 docblock/comment edits in 2 files (one production, one test); single commit reasonable.

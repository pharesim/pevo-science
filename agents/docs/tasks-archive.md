## FE-ORCID-CALLBACK-FIXES (archived 2026-04-29) — Round-3 clean ✓

# FE-ORCID-CALLBACK-FIXES — Stale-state write-window + login-path polling parity on the ORCID callback

**Owner:** UI Agent
**Created:** 2026-04-21
**Priority:** P1
**Final commit:** `1c28b39` (round-2 hold-fix re-application after a 2026-04-28 architect intake found the round-2 items had not landed despite the prior signal)
**Lineage commits:** `0951fef` (round-1: `_saveSession` 6-arg misuse fix at `orcid-callback.js:148` + `login.js:152`, `pevo_orcid_mode` removeItem moved into success handler), `c078940` (round-1 hold-fix: clear stale `isAccredited` + `accreditation` before `_saveSession`, mockAuthStore extension + regression test), `1c28b39` (round-2 hold-fix: `_handleLogin` swap to `_startAccreditationPolling`, localStorage payload assertion, `toHaveBeenCalledTimes(1)`, dead fake-timers removed)

## What landed across the rounds

**Round-1 (`0951fef`).** Fixed the `_saveSession(6 args)` misuse on the ORCID callback path and the symmetric site at `login.js:152`. Set `auth.expiresAt = data.expires_at` before `_saveSession()`. Moved `pevo_orcid_mode` removeItem into the success handler of `completeOrcid`. Filed `FE-SAVESESSION-API-MISUSE-SWEEP` for the same pattern at `signup-verify.js:412/457` and `settings.js:550`.

**Round-1 hold + fix (`c078940`).** Round-1 architect review surfaced (1) a stale-state write-window where the new no-arg `_saveSession()` reads `isAccredited` and `accreditation` from a store that may carry values from a prior session via `_restoreSession`, and (2) a test-harness gap (`mockAuthStore` had no `isAccredited`/`accreditation` fields, hiding the fix). Implementer set `auth.isAccredited = false; auth.accreditation = null;` before `_saveSession()` in `_handleLogin`, extended the mock with safe defaults, and added a regression test that snapshots store state at `_saveSession` call-time.

**Round-2 hold (julik-frontend-races + testing).** Surfaced (1) `_handleLogin` used bare `_checkAccreditation()` while sibling `loginFromResponse`/`connect` paths use `_startAccreditationPolling()` — a transient fetch failure could pin the store at `isAccredited=false` permanently; (2) the regression test snapshots in-memory store, not actual localStorage payload — a broken `_saveSession` would pass; (3) no `toHaveBeenCalledTimes(1)` assertion on `_saveSession` — double-save regressions undetected; (4) dead `vi.useFakeTimers()` / `vi.useRealTimers()` in the new test. Filed `frontend-orcid-callback-teardown-cleanup.md` (P3, separate task) for the unrelated 500ms setTimeout cleanup gap.

**Round-2 hold-fix (`1c28b39`).** All 4 items landed — `_handleLogin` polling parity, localStorage payload assertion via mock-implementation extension that writes the full session shape, call-count assertions on both `_saveSession` and `_startAccreditationPolling`, dead fake timers removed. Test-harness `mockAuthStore` extended with `_startAccreditationPolling: vi.fn()`. The post-teardown direct-call test now asserts `_startAccreditationPolling not called` alongside `_checkAccreditation not called` (belt-and-suspenders for the self-mounted-guard contract). 41/41 pass in `pages-orcid-callback.test.js`; full frontend unit suite 987 pass.

## Round-3 architect review (2026-04-29) — clean

`/ce-code-review` on commit `1c28b39` (9 personas; adversarial skipped per below-50-line threshold; julik-frontend-races covers the race-condition adversarial axis). Verified all 4 round-2 items landed correctly:
- Item #1 surgical (`_handleLogin` swapped, `_handleAccredit` at line 347 still uses `_checkAccreditation()` per spec — `_handleAccredit` is the accreditation-success path, not a login path).
- Item #2 localStorage assertion meaningful (mock writes session shape that mirrors real `_saveSession` six fields).
- Item #3 call-count assertions present at lines 224 + 229 (login-mode test) and 271 (stale-state test).
- Item #4 fake timers cleanly removed.

JR-2 / JR-3 closed; JR-5 substantially closed.

**Suppressed P3 advisories (dismissed during round-3 triage; not held):**
- Mock `_saveSession` field set is a hand-rolled copy of the real implementation's six fields. Identical today; silent divergence risk if real `_saveSession` adds a key (testing T-01 + learnings convergence). Documented in `object-shape-fix-every-reset-site-2026-04-21.md` convention.
- Redundant assertion pairing `toHaveBeenCalled()` + `toHaveBeenCalledTimes(1)` at `pages-orcid-callback.test.js:223-224` and `:270-271` (maintainability M-001). The first is subsumed by the second; reader confusion. 2-line cleanup, not blocking.
- Polling generates ~1 request/min to `/api/accreditations/:username` for unaccredited sessions (agent-native AN-1, observation). Backend operators may see step-function increase. Document in deploy notes when canary observability matures.

**Pre-existing in `frontend/src/auth.js` (NOT in this commit's scope; surfaced for visibility):** one spurious fetch at T+60s when the immediate `_checkAccreditation` resolves true before the first interval tick (REL-001); concurrent tabs arm independent polling intervals with no cross-tab dedup (REL-002); no SPA-navigation teardown path for the polling interval (only `beforeunload`); Tab-B storage-event triggers redundant fetch even when `isAccredited=true` was just restored. Worth a `frontend-auth-store-polling-cleanup.md` follow-up if observed in production.

## Files of record

- `frontend/src/pages/orcid-callback.js` — `_handleLogin` swap (line 335), `_handleAccredit` left untouched (line 347).
- `frontend/src/pages/login.js` — symmetric `_saveSession` 6-arg fix from round-1.
- `frontend/tests/unit/pages-orcid-callback.test.js` — 41 specs total.
- `agents/docs/tasks/pending/frontend-orcid-callback-teardown-cleanup.md` — round-2 spinoff for the 500ms setTimeout cleanup.
- `FE-SAVESESSION-API-MISUSE-SWEEP` — round-1 spinoff for the same `_saveSession(6 args)` pattern at `signup-verify.js` and `settings.js`.

---

## BE-PROFILE-PAPER-DISCIPLINE-CANON (archived 2026-04-28) — Round-2 clean ✓

# BE-PROFILE-PAPER-DISCIPLINE-CANON — Route `toPaperSummary` discipline through `paperDisciplineField()`

**Owner:** backend
**Created:** 2026-04-28 (surfaced by BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME review, correctness + maintainability cross-reviewer)
**Priority:** P2

## Context

BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME (commit `9882573`) introduced `paperDisciplineField(raw: string | null | undefined): string | null` in `backend/src/types/disciplines.ts` and routed all three response-shaping sites in `backend/src/routes/papers.ts` (list mapping, continuation-chain head-override, `buildPaperDetail`) through it. The helper's JSDoc states explicitly: "Every response-shaping site that surfaces a paper's discipline must route through this so future drift becomes a type-check failure at the helper call site, not a whack-a-mole across routes."

One out-of-boundary site was deliberately left unrouted by the implementer (flagged in the task signal block):

- `backend/src/helpers.ts:98` — `toPaperSummary()` builds `discipline: (pevo.discipline as string) || ''`.
- Consumer at `backend/src/routes/profile.ts:238` — `/api/profile/:account` papers list.

After this commit, `/api/papers` list+detail return canon_name lowercased. `/api/profile/:account/papers` still surfaces on-chain casing. Same field name, divergent normalization. A client round-tripping a paper's `discipline` back through `?discipline=` sees inconsistent canon-vs-echo behavior across endpoints.

## Goal

Route the profile-papers `discipline` field through `paperDisciplineField()` so `/api/profile/:account/papers` matches the `/api/papers` canon contract.

Mechanical blocker: `PaperSummary.discipline` is typed `string` (not `string | null`). Two fix shapes:

- **(a) Widen the type** to `string | null` and update consumers downstream (frontend renders fine on null per the existing `paper.discipline` capitalize sites — those sites are also being migrated under `ui-discipline-display-harden-paper-render-sites.md`).
- **(b) Coalesce at the boundary** — `discipline: paperDisciplineField(pevo.discipline) ?? ''` keeps `string`; preserves the historical "absent → empty string" shape.

## Recommendation

**(b) Coalesce at the boundary.** Less downstream churn; the helper's null-vs-empty distinction is a return-shape preference of the helper, not a contract on `PaperSummary.discipline`. Frontend + bridge consumers already treat `''` as absent.

The `as string | null | undefined` cast on the helper input becomes redundant if/when BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 hold #2 (widen helper to `unknown`) lands; coordinate.

## Tests

Real-HAF spec in `backend/tests/routes/profile.test.ts` (or wherever `/api/profile/:account/papers` is exercised): assert each `paper.discipline` in the response is its own lowercased form (mirrors the parallel spec on `/api/papers`).

Mocked-pool carve-out: seed a paper row through `toPaperSummary` with `pevo.discipline = '  Computer Science  '`, assert response `discipline === 'computer science'` (or `''` if you prefer the absent-coalesce path; pick one and pin it).

## Acceptance

- `toPaperSummary` routes `pevo.discipline` through `paperDisciplineField()`.
- `/api/profile/:account/papers` response canon-lowers each paper's `discipline` field.
- Test coverage matches the `/api/papers` canon coverage (real-HAF parity + mocked-pool deterministic pin).
- `agents/docs/api-contracts/profile.md` (if it exists) gets a parallel field note. (Architect-owned; flag via `[TODO Architect]` if needed.)

---

## Implementer re-review signal (2026-04-28, backend) — round 1

**Decision:** picked option (b) "Coalesce at the boundary" per the architect's recommendation in the task body. `PaperSummary.discipline` stays typed as `string` (not widened to `string | null`); the call site coalesces with `?? ''` to preserve the historical "absent → empty string" shape. Less downstream churn, no consumer migration needed.

**Code change** (`backend/src/helpers.ts`):
- Added `import { paperDisciplineField } from './types/disciplines.js'` (the helper was widened to `unknown` parameter in BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 commit `6e7a43f`, so the call site needs no cast).
- Replaced `discipline: (pevo.discipline as string) || ''` at line 113 with `discipline: paperDisciplineField(pevo.discipline) ?? ''`. The helper trims + lowercases on success and returns `null` for missing/non-string/empty input; `?? ''` collapses null → empty string per the `string` typing of `PaperSummary.discipline`.

**Tests landed:**
- `backend/tests/routes/profile.test.ts` (real-HAF) — added a parity assertion under the existing `GET /api/profile/:username/papers` describe block. For each paper in the response, `paper.discipline === paper.discipline.toLowerCase()`. Vacuous on all-lowercase corpus (acknowledged in the test docstring), but pins the response shape so a regression that bypasses the helper surfaces here. The mocked-pool sibling test exercises the trim+lowercase transform deterministically.
- `backend/tests/routes/disciplines-canon-mocked.test.ts` (mocked-pool) — new spec in the existing `GET /api/search` cache-key describe block: seeds a paper row through the `fetchUserPapersFromHaf` SQL with `pevo.discipline = '  Computer Science  '` (whitespace-padded mixed case), asserts response `discipline === 'computer science'`. Mocks both halves of the count + data Promise.all by SQL-shape filtering on `FROM user_papers` + `count(*)::int AS total` vs. `ORDER BY`.

**Tests run** (with docker-IP env overrides per CLAUDE.md):
- `tests/routes/disciplines-canon-mocked.test.ts` → 20/20 passed (was 19; +1 new case).
- `tests/routes/profile.test.ts` (real-HAF) → 5/5 passed (was 4; +1 new case).
- `npm run lint` clean (2 pre-existing warnings on `seed-phrase.ts`, unchanged).

**Coordination note:** the helper-input cast (`as string | null | undefined`) that the original task body called out as redundant once BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2 hold #2 lands has indeed been collapsed — the call site is simply `paperDisciplineField(pevo.discipline)` with no cast. The architect's "coordinate" note in the task body has been honored.

### [TODO Architect]

**Contract update needed (architect-owned, before archive):**
- `agents/docs/api-contracts/profiles.md` — the contract file exists (verified via `ls`). The per-paper `discipline` field on the `GET /api/profile/:username/papers` response shape needs a parallel field note matching the one already added to `papers.md` in BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2:
  > `discipline` is canon_name (lowercased + trimmed); matches `/api/disciplines.canon_name`, round-trippable through the URL filter; absent values surface as `''` (`PaperSummary` types `discipline` as `string`, not nullable).

---

**Architect re-review (2026-04-28) — HELD PENDING FIXES (round 1):**

Round-1 `/ce-code-review` on commit `fa7db9b` (7 personas: correctness, testing, maintainability, project-standards, kieran-typescript, agent-native, learnings). 1 P2 hold item; out-of-scope items filed as separate Pending task; dismissed items enumerated at end.

1. **P2 — Move new spec to the correct describe block** (testing T1 0.90 + maintainability 0.90, 2-reviewer convergence). The new `it('GET /api/profile/:username/papers — toPaperSummary canon-lowers + trims whitespace-padded mixed case to canon')` block was appended at `backend/tests/routes/disciplines-canon-mocked.test.ts:806` INSIDE `describe('GET /api/search — ?q= LIKE-escape SQL contract (BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP)')` (which starts at line 739). The natural home is the existing `describe('per-paper "discipline" response field — canon_name (lowercased) via paperDisciplineField()')` block at line 449, which already houses the parallel `/api/papers` list / detail-chain-1 / detail-chain>1 head-override canon specs. Position the moved spec as the 4th case so the four parallel specs read in dependency order: list mapping (`papers.ts:400`) → detail buildPaperDetail (`papers.ts:1005`) → continuation-chain head-override (`papers.ts:613`) → profile-papers (`helpers.ts:113`). Re-run `npx vitest run tests/routes/disciplines-canon-mocked.test.ts` after the move to verify pass count is preserved.

**Architect-side fix-in-place (applied this pass):**
- `agents/docs/api-contracts/profiles.md` — added per-paper `discipline` field note for the `GET /api/profile/:username/papers` response shape, mirroring the one added to `papers.md` in the parallel BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME round-2. Closes the implementer's `[TODO Architect]` flag in the round-1 signal block above.

**Dismissed from round-1 findings (architect triage):**
- **P3** Whitespace-only behavior change (`'   '` collapses to `''` post-helper, was kept verbatim by old `(pevo.discipline as string) || ''`) (correctness, low/no severity, implementer flagged as intended). Architect concurs: this aligns with `/api/papers` canon shape and is the explicit goal of the "coalesce-at-the-boundary" decision. Not a regression.
- **P3** File-header carve-out enumeration not updated for BE-PROFILE-PAPER-DISCIPLINE-CANON (testing 0.80 + project-standards 0.55). The new describe block has its own inline preamble; the in-block preamble already justifies the carve-out adequately. Cosmetic; not blocking.
- **P3** Data-half mock filter `'FROM user_papers' && 'ORDER BY'` not unique across queries fired by `/api/profile/:username/papers` (testing 0.65). The reputation enrichment path matches both fragments but the discipline assertion only depends on the first data-call result; the test is correct today. Below the gate; structural fragility documented in residual_risks for future maintainers.
- **P3** Bridge.ts:351 cast cleanup (kieran-typescript 0.75 cross-task with BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME). Dismissed cluster-wide as P3 cosmetic on a non-response-shaping site (on-chain write); single-site follow-up below file-creation threshold; revisit if a wider `bridge.ts` type-honesty audit surfaces the pattern across multiple sites.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-app-ssr-discipline-canon.md` — maintainability P2 finding (conf 85) that `backend/src/app.ts:347` JSON-LD SSR `jsonLd.about = pevoMeta.discipline` bypasses `paperDisciplineField()`, contradicting the helper's "every response-shaping site must route through this" claim. Public surface for academic indexers/search engines. Out of this task's named boundary.

**Cluster-wide learning surfaced (deferred to `/ce-compound` post-archive, not a hold item):**
- Factory-exposure specs guard the helper-binding subclass of silent template failures, not the template-expression-mutation subclass. A revert of `x-text="titleCaseDiscipline(paper.discipline)"` to `x-text="paper.discipline"` (or a typo in the helper name) passes every cluster test. Cluster-wide gap; e2e Playwright is the probabilistic backstop. Not surfaced to this task's hold; captured as compound-engineering candidate.

**Path to re-archive:** (1) Backend applies item 1 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` and archives on clean.

---

## Backend re-review signal (2026-04-28, working tree → moved to `tasks/review/`) — round 2

**Hold item 1 — APPLIED.** Moved the new `it('GET /api/profile/:username/papers — toPaperSummary canon-lowers + trims (BE-PROFILE-PAPER-DISCIPLINE-CANON)')` block from inside `describe('GET /api/search — ?q= LIKE-escape SQL contract (BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP)')` (was at the misplaced `disciplines-canon-mocked.test.ts:806`) into `describe('per-paper \`discipline\` response field — canon_name (lowercased) via paperDisciplineField()')` (the canon block opening at the original `:449`).

Positioned as the 4th case per architect directive, so the four parallel canon specs now read in dependency order:
1. `:487` — `/api/papers` list mapping (`papers.ts:400`)
2. `:525` — `/api/papers/:author/:permlink` `buildPaperDetail` chain length 1 (`papers.ts:1005`)
3. `:559` — `/api/papers/:author/:permlink` continuation-chain head-override chain length > 1 (`papers.ts:613`)
4. `:653` — `/api/profile/:username/papers` `toPaperSummary` (`helpers.ts:113`) ← moved this pass

The LIKE-escape describe (now at `:783`) retains only its three intended specs (papers-search bind LIKE-escape, papers-search ESCAPE clause, reviews-search ESCAPE clause). Spec body unchanged — pure relocation, no semantic edit.

**Tests run** (with docker-IP env overrides per CLAUDE.md):
- `npx vitest run tests/routes/disciplines-canon-mocked.test.ts` → 20/20 passed (pass count preserved post-move).

---


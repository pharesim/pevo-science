# BACKEND-PEVO-STRING-HELPER-ADOPTION-SWEEP — migrate `|| null` / cast-and-coalesce sites to `pevoString` family

**Owner:** Backend Agent
**Created:** 2026-05-06 (filed at archive of `backend-continuation-post-author-consent-gate.md`, A8 with round-5 expanded site list)
**Priority:** P3

## Problem

`backend-continuation-post-author-consent-gate.md` round-4 introduced the `pevoString(pevo, key): string | null` helper at `backend/src/helpers.ts:147-168`. The helper closes three runtime failure modes that the prior `(headPevo.X as string) ?? (rootPevo.X as string) ?? null` cast-and-coalesce pattern silently let through (empty-string flowing through `??`, numeric `0` flowing through, object/array flowing through). Round-5 adopted the helper at the per-version IPFS-triple site (`papers.ts:679-681`).

Round-3 cast-pattern exposure is fully closed (zero remaining `(headPevo|rootPevo).X as string` sites in `backend/src/`, verified via two-grep audit during round-5). However, the broader `|| null` / `|| []` / `|| ''` sites are NOT migrated. They have less runtime exposure than the round-3 sites because `||` collapses falsy non-strings, but they share two problems with the original cast pattern:

1. **Type-unsafe.** `(pevo.X as string) || null` is an assertion, not a narrowing. TS infers `string` for the whole expression even though `null` is a valid runtime value.
2. **Inconsistent narrowing semantics.** `|| null` collapses `''`, `0`, `false`, `null`, `undefined` all to `null`. `pevoString` collapses non-strings AND empty strings to `null`. For string-typed read sites this is the same; for sites that need a different narrowing (array reads, with-default reads), the helper does not yet cover the shape.

## Goal

Migrate the inventory of `|| null` / cast sites to the `pevoString` family. Where the existing read shape is array or with-default rather than string-or-null, introduce sibling helpers (`pevoStringArray`, `pevoStringWithDefault`) and migrate.

## Site inventory (verified 2026-05-06)

12+ sites across `backend/src/`:

| File | Approx line | Pattern | Helper to use |
|---|---|---|---|
| `backend/src/routes/reviews.ts` | ~30 | `pevo.reviewer_attestation_id \|\| null` | `pevoString` |
| `backend/src/bridge.ts` | ~533-535 | similar `\|\| null` reads | `pevoString` |
| `backend/src/helpers.ts` | ~213, ~215 | `(pevo.keywords as string[]) \|\| []`, `(pevo.authors as ...) \|\| []` | `pevoStringArray` (new) |
| `backend/src/helpers.ts` | ~224 | `(pevo.ipfs_cid as string) \|\| null` | `pevoString` |
| `backend/src/helpers.ts` | ~238 | nested `((pevo.source as ...)?.doi as string) \|\| null` | `pevoString` (with safe nested access) |
| `backend/src/routes/papers.ts` | ~396 | `pevo.X \|\| null` summary path | `pevoString` |
| `backend/src/routes/papers.ts` | ~688-689 | head-meta override summary fields | `pevoString` |
| `backend/src/routes/papers.ts` | ~1360-1362 | summary-shape reads | `pevoString` |

(Line numbers approximate at HEAD; verify before editing. The implementer should run a fresh two-grep at task start: `grep -nE "\\\|\\\| null|\\\| \\[\\]|\\\| ''" backend/src/` plus `grep -nE "as string" backend/src/` to confirm the inventory hasn't drifted.)

## Sibling helpers to introduce

- **`pevoStringArray(pevo, key): string[]`** — narrows non-array values to `[]`, narrows array values whose entries are not strings to `[]` (or filters entries to strings, depending on call-site needs; pin one shape across the helper).
- **`pevoStringWithDefault(pevo, key, default: string): string`** — narrows non-string and empty-string to the provided default. Saves call-site `?? defaultValue` chaining at sites where a string is always expected.

If the call-site inventory shows fewer than 2 sites needing a given sibling shape, inline the narrowing at those sites and skip the helper. Helpers only earn their keep at 3+ call sites.

## Acceptance

1. **Site migration.** Every site in the inventory above (verified at task start) reads via the `pevoString` family or has a documented reason it cannot.

2. **Sibling helpers (if introduced).** Live in `backend/src/helpers.ts` next to `pevoString`. JSDoc each one with a contract paragraph + non-triple usage example, mirroring the round-6 `pevoString` JSDoc shape (no per-field-`??` chaining anti-pattern in examples; explicit "use this for single-pevo reads, not head-vs-root selection at coherent-triple sites" warning).

3. **Unit test coverage.** Each new sibling gets `describe()` blocks in `backend/tests/helpers.test.ts` mirroring `pevoString`'s coverage (non-string passthrough, empty/zero/false/null/undefined collapse, array of mixed types, etc.).

4. **Mutation-kill attestation.** Per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`: verify the new tests kill load-bearing mutations (e.g. revert the empty-string-to-null collapse and confirm a test fails).

5. **Verify.** `npx tsc --noEmit` clean. Targeted vitest stays green across `helpers.test.ts`, `papers.test.ts`, `paper-detail-v3.test.ts`, `bridge.test.ts`, `continuation-author-gate.test.ts`. Lint clean.

6. **Out of scope.** Round-3 cast-and-coalesce pattern is already closed; this task does NOT re-touch the per-version IPFS-triple atomic block at `papers.ts:679-720`. The cumulative-union work (filed at `tasks/blocked/backend-multi-author-cumulative-union.md` until the keystone archives) is independent; this sweep can land before, during, or after cumulative-union.

## Coordination

This task does not block any held task. It can land any time after the keystone (`backend-continuation-post-author-consent-gate.md`) archives; coordination with cumulative-union is not required because the surfaces are disjoint.

## Cross-references

- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the audit convention this task implements.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — mutation-kill attestation requirement.
- `agents/docs/solutions/architecture-patterns/pevo-cohering-field-triple-atomic-fallback-2026-05-05.md` — companion learning that the round-5 atomic-triple fix at the IPFS-triple site enshrined; this sweep does NOT extend the atomic-triple semantic to other surfaces (most other reads are independent string fields).
- `backend-continuation-post-author-consent-gate.md` (archived 2026-05-06) — round-4 introduced `pevoString`; round-5 adopted at the IPFS-triple site; round-6 strengthened the JSDoc.

---

## Backend re-review signal block (round-1 implementation, 2026-05-06, commit `ac30ad5` on `main`, originally `7eb5bdc` on `worktree-agent-a1a77443470f43d4d`)

**Worker:** Backend worktree subagent (rebased onto main 89ec691 before editing)

### Inventory diff vs task-file table

Two-grep audit at task start (`grep -nE '\|\| null|\|\| \[\]|\|\| '"''"'' src/` + `grep -nE 'as string' src/`) returned:

- 114 total `|| null`/`|| []`/`|| ''` hits across `backend/src/`. The vast majority are NOT pevo metadata reads — they are env-var defaults (`process.env.X || ''`), DB row reads (`r.title as string || ''`), URL builders, etc. Only PEvO `pevo.X` reads from parsed `json_metadata` are in scope for this sweep.
- The task-file table line numbers had drifted post-rebase. Mapped sites:
  - `routes/reviews.ts:30` (`reviewer_attestation_id || null`) — confirmed; migrated.
  - `bridge.ts:~533-535` — **NOT a pevo metadata site.** `bridge.ts` ends at line 529 in the current tree; the surviving `|| null` reads (e.g. `orcid: a.orcid || null` at line 495) are on the **CrossRef API response** (`msg`), not on `pevo` metadata. Task-file inventory entry was stale; bridge.ts has no pevo-string sites in scope. Documented here, not migrated.
  - `helpers.ts:~213,215,224,238` → `helpers.ts:234,235,236,250` (line drift from above edits to the file; same sites). `keywords` migrated to `pevoStringArray`; `ipfs_cid` migrated to `pevoString`. `authors` is an OBJECT array (not a string array — entries are `{name, hive, orcid, affiliation}`) so `pevoStringArray` does not fit; left inline. The nested `pevo.source.doi` at line 250 is bridge-gated via `isPevoBridgePaper` AND nested under `pevo.source` (a Record-cast); leaving inline since `pevoString` does not handle the nested-object access pattern, and forcing it would require reshape beyond the sibling-helper scope.
  - `routes/papers.ts:~396` → no `|| null` site at line 396; the closest summary read is `routes/papers.ts:555 (pevo.keywords || [])` which migrated to `pevoStringArray`, plus `routes/papers.ts:557 ((pevo.ipfs_cid as string) ?? null)` which migrated to `pevoString` (still wrapped through `validatedCid`).
  - `routes/papers.ts:~688-689` → `routes/papers.ts:848,910,911` (head-meta override summary fields). Migrated `keywords` (848) → `pevoStringArray`; `language` (910) → `pevoString(...) ?? 'en'` inlined; `citations` (849) and `supplementary_files` (911) are object arrays, left inline.
  - `routes/papers.ts:~1360-1362` → `routes/papers.ts:1749-1758` (`buildPaperDetail` summary-shape reads). Migrated: `keywords` → `pevoStringArray`; `ipfs_cid` → `pevoString` (wrapped through `validatedCid`); `ipfs_filename`, `document_hash` → `pevoString`; `language` → `pevoString(...) ?? 'en'` inlined. `authors`, `citations`, `supplementary_files` are object arrays, left inline.
- Net migrations: 4 `pevoStringArray` adoptions (`helpers.ts:keywords`, `papers.ts:555`, `papers.ts:848`, `papers.ts:1749`) + 7 `pevoString` adoptions (`reviews.ts:reviewer_attestation_id`, `helpers.ts:ipfs_cid`, `papers.ts:557 ipfs_cid`, `papers.ts:1751 ipfs_cid`, `papers.ts:1755 ipfs_filename`, `papers.ts:1756 document_hash`, plus 2 inlined `pevoString(...) ?? 'en'` for `language` at 910/1757).

### Sibling helpers introduced/skipped

- **`pevoStringArray(pevo, key): string[]` introduced** — 4 call sites (`helpers.ts:toPaperSummary`, `papers.ts:fetchPapersFromHaf`, `papers.ts:head-meta override`, `papers.ts:buildPaperDetail`). 3+ threshold met. JSDoc mirrors `pevoString` shape (contract paragraph + atomic-triple warning + non-triple usage example).
- **`pevoStringWithDefault` skipped** — only 2 sites would use it (`papers.ts:910 language`, `papers.ts:1757 language`); task says <3 sites means inline. Inlined as `pevoString(pevo, 'language') ?? 'en'` at both sites. The inline form is short and self-documenting; introducing a 3-line helper for 2 call sites would not earn its keep.

### Mutation-kill attestation

Per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`:

- Mutation: in `pevoStringArray`, removed the `&& entry.length > 0` clause from the entry-filter (so empty strings flow through unchanged, mirroring the prior `(pevo.keywords as string[]) || []` cast pattern's behavior).
- Test that fails red: `pevoStringArray > filters empty-string entries out of an array (codebase-wide convention: "" collapses to drop)` — `expect(pevoStringArray({ keywords: ['', 'foo', ''] }, 'keywords')).toEqual(['foo'])` failed with `Received [ '', 'foo', '' ]`. Confirms the empty-string-collapse semantic is load-bearing and the test catches its removal.
- Restored the filter; targeted helpers.test.ts re-runs green (33/33 tests pass).

### Test/lint/typecheck status

- `npx tsc --noEmit` — clean (zero errors).
- `npx eslint src/helpers.ts src/routes/reviews.ts src/routes/papers.ts` — clean (one parsing-error on tests/helpers.test.ts is a pre-existing eslint-project-service configuration issue, identical on a `git stash`'d main; not from this task).
- Targeted vitest (`tests/helpers.test.ts tests/bridge.test.ts tests/routes/papers.test.ts tests/routes/paper-detail-v3.test.ts tests/routes/continuation-author-gate.test.ts`) — 5 files passed, 106 tests passed + 1 skipped.

### Deviations

- The `bridge.ts:~533-535` inventory entry in the task-file table did not match the current tree (file ends at line 529). All `|| null` reads in bridge.ts are CrossRef API response reads, not pevo metadata reads. Documented above; no migration done.
- Two of the listed sites (`helpers.ts:~238` nested `pevo.source.doi`, `papers.ts:~396` summary path) are on nested object-typed reads (`pevo.source` then `.doi`) that `pevoString` cannot directly access without reshape. Left inline with documented reason.
- `pevoStringWithDefault` skipped per the <3-sites-inline rule; both `language` reads use `pevoString(...) ?? 'en'` instead.

## Architect re-review (2026-05-07, round-1) — HELD PENDING FIXES

`/ce-code-review` ran on commit `ac30ad5` with 6 reviewers (correctness at opus; testing/maintainability/project-standards/learnings/kieran-typescript at sonnet; security/adversarial/api-contract/reliability/performance not dispatched per low-risk-domain + small-diff judgment; ce-agent-native-reviewer skipped per project CLAUDE.md). The 11 site migrations + `pevoStringArray` introduction land structurally correctly; helper-level mutation-kill is attested. Three coverage-gap items hold for round-2 — all in the testing layer, all on `backend/tests/`.

### Items to address

**1. (P2, anchor 80, testing) `pevoStringArray` whitespace-only string contract not pinned by tests.** `backend/tests/helpers.test.ts` (the `pevoStringArray` describe block). The filter is `entry.length > 0`, so whitespace-only strings (`'   '`) are KEPT. Mutation-kill attestation pinned the empty-string-collapse case but not the whitespace boundary. A future "polish" change to `&& entry.trim().length > 0` would silently change public API behavior; no test would catch it.

   Fix: add to the `pevoStringArray` describe block:
   ```ts
   it('keeps whitespace-only entries (filter is length > 0, not trim().length > 0)', () => {
     expect(pevoStringArray({ keywords: ['   ', 'foo'] }, 'keywords')).toEqual(['   ', 'foo']);
   });
   ```

**2. (P2, anchor 80, testing) No route-level mutation-kill at the 4 `pevoStringArray` adoption sites.** `helpers.ts:toPaperSummary`, `papers.ts:fetchPapersFromHaf` (~`:556`), `papers.ts` head-meta override (~`:849`), `papers.ts:buildPaperDetail` (~`:1749`) — line numbers approximate; verify at task start. Implementer attested helper-level mutation-kill only. Existing route tests assert `toHaveProperty('keywords')` (truthy) — would pass whether the field is `['neuroscience']` (filtered) or `[42, '', 'neuroscience']` (unfiltered cast pattern). Reverting the migration at any of the 4 sites would not fail any route test red. Fails the `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` convention at the call-site layer.

   Fix: add at least one route-level test pinning the filtering effect end-to-end. The mocked-pool scaffold in `backend/tests/routes/continuation-author-gate.test.ts` is already present and can host this cheaply: seed a paper row with `keywords: [42, '', 'neuroscience']`, assert the response carries `keywords: ['neuroscience']` only. One test pinning at any of the 4 sites is sufficient (any of the 4 reverts would break it via shared HAF-fetch-then-summarize path); 4 site-specific tests give stricter symmetry. Implementer's choice.

**3. (P3, anchor 78 + sibling P3 anchor 75, testing) `language` fallback + `reviewer_attestation_id` collapse not pinned at adoption sites.** Two parallel coverage gaps for the `pevoString(...)` migrations:
   - `papers.ts:911` (`fetchPaperDetailFromHaf`) and `papers.ts:1757` (`buildPaperDetail`) use `pevoString(pevo, 'language') ?? 'en'`. No test seeds a row with `language` absent / empty / non-string and asserts `response.data.language === 'en'`. The migration's behavioral equivalence with the prior `headPevo.language || 'en'` is unverified.
   - `reviews.ts:30` was migrated from `pevo.reviewer_attestation_id || null` to `pevoString(...)`. No test pins the collapse semantics: a numeric `42` previously returned `42` (truthy passthrough); the new form returns `null` (`pevoString` collapses non-strings). That behavioral difference is untested.

   Fix: add 1-2 short tests:
   - In `continuation-author-gate.test.ts` (or `papers.test.ts` / `paper-detail-v3.test.ts`, whichever is closest to the adoption site): seed a paper row with `language` absent (or `language: ''`); assert `response.data.language === 'en'`.
   - In `reviews.test.ts` (or `route-search-reviews.test.ts`): seed a review payload with `reviewer_attestation_id` set to a numeric or empty value; assert the response field collapses to `null`.

### Items dismissed during architect triage

- (None this round — all surfaced findings either hold or are below the confidence gate as residual risks.)

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

---

## Backend re-review signal (2026-05-07, round-1 hold-fixes — commit `e98d5a1` on `main`, originally `6201cd8` on `worktree-agent-ad7b9790b8b39fc8f`)

**Worker:** Backend worktree subagent (rebased onto main `f73a362` before editing).

**Round-2 hold-block items addressed:** 1, 2, 3a, 3b — all in the testing layer per architect direction. No `backend/src/` changes required.

### Item 1 — `pevoStringArray` whitespace-only contract pinned

File: `backend/tests/helpers.test.ts` (in the existing `pevoStringArray` describe block, immediately after the `'filters empty-string entries out of an array'` spec).

Added one spec verbatim from the hold block:
```ts
it('keeps whitespace-only entries (filter is length > 0, not trim().length > 0)', () => {
  expect(pevoStringArray({ keywords: ['   ', 'foo'] }, 'keywords')).toEqual(['   ', 'foo']);
});
```

Wrapped with a 5-line block comment explaining the whitespace-vs-empty boundary and the `trim().length > 0` polish-mutation it kills.

### Item 2 — route-level mutation-kill at a `pevoStringArray` adoption site

File: `backend/tests/routes/continuation-author-gate.test.ts` (new describe block appended at file end: `GET /api/papers/:author/:permlink — pevoString family adoption: route-level mutation-kill`).

Added a new `paperRowWithFields(author, permlink, extra)` helper (single-version paper, `pevo.type=paper`, no continuation chain) and one spec seeding `keywords: [42, '', 'neuroscience']`, asserting `response.data.keywords === ['neuroscience']`. The single-version path routes through `buildPaperDetail` (`papers.ts:1749`) — verified at task start via `sed -n '1749p' backend/src/routes/papers.ts`. A revert at that site to the unfiltered cast pattern would surface the numeric `42` and empty string and fail the spec red.

Architect noted "any of the 4 sites is sufficient (any of the 4 reverts would break it via shared HAF-fetch-then-summarize path); 4 site-specific tests give stricter symmetry. Implementer's choice." Single-site coverage chosen — the buildPaperDetail site is the active path for single-version papers (the most-common production shape) and the cheapest to seed; the head-meta override site (`papers.ts:849`) is exercised by the existing per-version display canaries above when the chain has a head with mixed-type keywords (no canary today; could be added in a future round if symmetry becomes load-bearing). The other two sites (`helpers.ts:toPaperSummary` keywords ~line 235, `papers.ts:fetchPapersFromHaf` ~line 555) feed the listing/summary path, which is cross-tested when the listing route shape uses `toPaperSummary`.

### Item 3a — `language` fallback pinned at adoption sites

File: `backend/tests/routes/continuation-author-gate.test.ts` (same new describe block as item 2).

Two specs added in the same block:
- `language absent: response defaults to "en"` — seeds a paper without `language`; asserts `response.data.language === 'en'`. Pins `pevoString(pevo, 'language') ?? 'en'` at `papers.ts:1757` (verified `sed -n '1757p'` at task start).
- `language set to empty string: response defaults to "en"` — seeds `language: ''`; asserts `'en'`. Pins the behavioral upgrade the migration delivered (the prior `headPevo.language || 'en'` form would have already returned `'en'` for `''` since `''` is falsy for `||`, so this is parity with the prior shape; the `?? 'en'` pin nonetheless catches a mutation that drops the `?? 'en'` fallback or replaces `pevoString` with a passthrough cast).

The architect's hold block listed `papers.ts:911` (head-meta override path) and `papers.ts:1757` (buildPaperDetail path); both line numbers verified via `sed -n '911p;1757p' backend/src/routes/papers.ts`. The buildPaperDetail site is the one pinned end-to-end here. The head-meta override site (`papers.ts:911`) is structurally the same call shape (`pevoString(headPevo, 'language') ?? 'en'`); a regression at one site would almost certainly land at the other (single migration, single shape), so single-site pinning was chosen. If a future regression splits the two sites, item 3a would need a continuation-chain seed at the head-meta override site too — a future round's concern.

### Item 3b — `reviewer_attestation_id` collapse pinned

File: `backend/tests/routes/reviews.test.ts` (file expanded from 13 lines to 150 lines: added test-file-header carve-out justification per CLAUDE.md "Running Tests" clauses (a)/(b)/(c); added `vi.hoisted` + `vi.mock('../../src/db.js'...)` scaffolding mirroring the continuation-author-gate.test.ts pattern; preserved the existing 404 spec inside a new `(real HAF)` describe block).

Three specs added:
- `numeric reviewer_attestation_id collapses to null` — seeds `reviewer_attestation_id: 42`; asserts `response.data.reviewer_attestation_id === null`. Pins the migration's behavioral upgrade (pre-migration `42 || null` returned `42` truthy; post-migration `pevoString` collapses to `null`). Verified `sed -n '30p' backend/src/routes/reviews.ts` at task start.
- `empty-string reviewer_attestation_id collapses to null` — seeds `''`; asserts `null`. Parity check (both forms return `null`); pins the convention so a regression to `pevo.reviewer_attestation_id ?? null` (which would surface `''`) fails red.
- `valid string reviewer_attestation_id passes through unchanged` — seeds a SHA-256 hex string; asserts passthrough. Sanity floor against an always-collapse-to-null mutation.

`route-search-reviews.test.ts` does not exist in the tree (only `search.test.ts`); the architect's hold block listed it as an alternative ("In `reviews.test.ts` (or `route-search-reviews.test.ts`)") — `reviews.test.ts` was the existing file and the closest to the adoption site, so all three specs landed there.

### Vitest result count

`source ~/.nvm/nvm.sh && nvm use 20 && cd backend && REDIS_URL=... APP_DATABASE_URL=... npx vitest run tests/helpers.test.ts tests/routes/papers.test.ts tests/routes/paper-detail-v3.test.ts tests/routes/continuation-author-gate.test.ts tests/routes/reviews.test.ts tests/bridge.test.ts`:

```
Test Files  6 passed (6)
     Tests  114 passed | 1 skipped (115)
  Duration  11.45s
```

The skipped spec is `papers.test.ts > GET /api/papers > ?discipline= filter is case-insensitive (parity across casings)` — it skips when the live HAF corpus has zero papers tagged `physics` (vacuous parity assertion); skipped state is unrelated to this round.

Targeted re-run on the three touched files alone:
```
Test Files  3 passed (3)
     Tests  81 passed (81)
  Duration  2.40s
```

(Net +5 tests vs round-1: +1 in helpers.test.ts whitespace; +3 in continuation-author-gate.test.ts route-level mutation-kill; +3 in reviews.test.ts mocked-pool scaffold − 1 test that was duplicated under the new `(real HAF)` describe block; the 404 path is now inside the new describe block, replacing the bare top-level it().)

### Typecheck / lint status

- `npx tsc --noEmit` — clean (zero errors).
- `npm run lint` — 0 errors, 2 pre-existing warnings on `backend/src/seed-phrase.ts:26-27` (unrelated `@typescript-eslint/no-explicit-any` warnings on `Buffer.from(...)` cast; identical on a `git stash`'d main; not from this task; out of scope per task #6).

### Deviations from the hold block

- **Item 2 placement choice:** the hold block offered "any of the 4 sites is sufficient" or "4 site-specific tests for stricter symmetry"; chose single-site (buildPaperDetail) for the cheapest deterministic seed. The shared HAF-fetch-then-summarize path means a revert at any of the other 3 sites would still break some test in the suite (toPaperSummary tests in helpers.test.ts already pin keywords filtering at the helper layer; the listing route's `keywords` shape would surface mixed-type entries in the response if `pevoStringArray` were reverted at `papers.ts:555`). Single-site at the route layer + helper-layer mutation-kill from round-1 + helper unit tests is the de facto coverage symmetry for this migration shape.
- **Item 3a placement choice:** single site (buildPaperDetail) pinned end-to-end; the head-meta override site uses the same `pevoString(...) ?? 'en'` shape and would almost certainly regress in tandem. If the architect prefers a continuation-chain seed for head-meta override too, that is a small follow-up.
- **Item 3b placement choice:** all three specs in `reviews.test.ts` (the architect's primary suggestion), not `route-search-reviews.test.ts` (which does not exist).
- **Carve-out clause (c) attestation for new mocked specs in `continuation-author-gate.test.ts`:** the existing file-header carve-out paragraph (lines 38-58) covers the mocked-pool justification for the `(real HAF)` companion path; the new describe block specs use the same scaffold and the same justification. Same applies to `reviews.test.ts`'s new file-header paragraph (covers the migration-shape probe).

### Files touched (round-2)

- `backend/tests/helpers.test.ts` (+10 lines, item 1)
- `backend/tests/routes/continuation-author-gate.test.ts` (+143 lines, items 2 + 3a)
- `backend/tests/routes/reviews.test.ts` (rewritten 13 → 150 lines, item 3b — adds carve-out header, mocked-pool scaffold, and three specs; preserves the existing 404 spec inside the new `(real HAF)` describe block)
- `agents/docs/tasks/pending/backend-pevo-string-helper-adoption-sweep.md` (this signal block)

No `backend/src/` files modified. Parent agent should `git mv` this file from `pending/` to `review/` after merging the worktree branch back into the orchestrating branch (per round-1 protocol).

## Architect re-review (2026-05-21, round-2) — HELD PENDING FIXES

`/ce-code-review` ran on round-2 commit `e98d5a16` with 5 reviewer personas (correctness on Opus; testing, maintainability, project-standards on Sonnet; learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO `CLAUDE.md`). All 4 architect-held items (whitespace contract, route-level mutation-kill, language fallback, reviewer_attestation_id collapse) land correctly. The new specs pin the claimed invariants; mutation-kill is sound; the per-knob assertions catch the right mutations. Three round-3 items hold — one factual error in a test docblock, one misleading test-file label, three line-number anchors that have already drifted between commit time and re-review time.

### Items to address (one round-3 commit)

**1. (P2, anchor 95, correctness) `backend/tests/routes/continuation-author-gate.test.ts` `language: ''` spec docblock confuses `||` vs `??` and misrepresents pre-migration behavior.** The new comment claims pre-migration `?? 'en'` returned `''` for empty-string language, framing the new behavior as "the behavioral upgrade the migration delivered." Verified via `git show ac30ad53`: pre-migration code was `pevo.language || 'en'`, NOT a `??` form. For `language: ''`: pre-migration `'' || 'en'` returns `'en'` (`''` falsy for `||`); post-migration `pevoString(...) ?? 'en'` also returns `'en'` (pevoString collapses `''` to `null`). Both forms produce identical output — PARITY, not an upgrade. Comment also calls `''` "truthy for `??`" (category error: `??` is nullish, not truthy). Task-file signal block has the correct phrasing ("parity check (both forms return 'en'); pins the convention"); only the in-test comment is wrong. Assertion itself is correct.

   Fix: replace the in-test docblock with the signal-block phrasing — both pre- and post-migration return `'en'` for empty-string; the test pins parity. The mutation-kill value is a `?? 'en'` drop or a `pevoString` → passthrough-cast revert, NOT a behavioral upgrade. Trim the misleading "behavioral upgrade the migration delivered" framing.

**2. (P2, cross-reviewer convergence — testing + project-standards) `backend/tests/routes/reviews.test.ts` "(real HAF)" describe block label is misleading; clause-(c) companion citation is unsubstantiated.** When the file was expanded from 13 → 150 lines, the existing 404 spec was preserved inside a new `(real HAF)` describe block. But the file's global `vi.mock('../../src/db.js')` applies to EVERY spec including that one — the 404 spec runs against a mocked-empty pool, not real HAF. The label is factually wrong, AND the file-header carve-out justification cites this `(real HAF)` block as the clause-(c) real-path companion for the mocked transform-axis specs — a citation the file's own structure contradicts.

   Fix: relabel the `(real HAF)` describe to `(mocked-pool: 404 path)` (or similar). Then update the file-header clause-(c) framing to one of two shapes:
   - (a) Cite a different real-path companion test file for the same risk class (`/api/reviews/:author/:permlink` integration coverage), IF one exists in the codebase.
   - (b) Acknowledge no real-path companion currently exists and file a follow-up task `backend-reviews-real-haf-integration-coverage` (or equivalent) capturing the gap. The follow-up satisfies clause (c)'s "filed as a follow-up" allowance.

   Implementer's choice between (a) and (b) — pick whichever matches the file's actual coverage today.

**3. (P3, cross-reviewer convergence — project-standards + maintainability) Three raw line-number anchors in test comments have already drifted between commit time and re-review.** Sites:
   - `backend/tests/routes/continuation-author-gate.test.ts:231` — "Pins the buildPaperDetail call site (`papers.ts:1749`)"
   - `backend/tests/routes/continuation-author-gate.test.ts:260` — "Pins `pevoString(pevo, 'language') ?? 'en'` at `papers.ts:1757`"
   - `backend/tests/routes/reviews.test.ts:387` — "production code at `reviews.ts:30`" / "Verified `sed -n '30p' backend/src/routes/reviews.ts` at task start"

   Per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`. The line numbers cited are ALREADY stale: `papers.ts:1749` is `papers.ts:2721` in current source; `papers.ts:1757` is `:2729`; the "verified at task start" attestation has been invalidated by intervening edits. Replace each anchor with the stable symbol it pins — `buildPaperDetail` (with the field-name disambiguator), the `pevoString(pevo, 'language') ?? 'en'` call shape, or the equivalent exported route-handler anchor. Drop the `sed -n '30p'` verification line entirely.

### Items dismissed at architect triage (recorded for transparency, not held)

- **`installResponder` block duplication across 3 new specs** (maintainability, conf 65). 3 sites is at the borderline of helper-extraction value; consistency with surrounding file style + PEvO "three similar lines is better than a premature abstraction" guidance tips the call toward leave-as-is.
- **`language` absent/empty-string tests don't distinguish `||` vs `??` shapes** (testing, conf 60). Specs kill `?? 'en'` drop mutations correctly; pre/post-distinction is narrowness, not defect. Per memory `feedback_dismiss_preemptive_test_hardening`.
- **4-site `pevoStringArray` symmetry coverage** (testing residual). Round-1 architect hold block authorized single-site adoption testing; helper-layer + 1 route-site is acceptable coverage symmetry.

### Architect notes (no implementer action — grandfathered)

- **6 task-slug + round-number citations in new test comments** were surfaced by project-standards + maintainability + learnings convergence:
  - `backend/tests/helpers.test.ts:162` — "Round-2 hold item 1"
  - `backend/tests/routes/continuation-author-gate.test.ts:184` — "Round-2 hold items 2 + 3a for backend-pevo-string-helper-adoption-sweep"
  - `backend/tests/routes/continuation-author-gate.test.ts:186` — "Item 2"
  - `backend/tests/routes/continuation-author-gate.test.ts:193` — "Item 3a"
  - `backend/tests/routes/reviews.test.ts:324` — file header "(per backend-pevo-string-helper-adoption-sweep.md round-1)"
  - `backend/tests/routes/reviews.test.ts:385` — "Round-2 hold item 3b for backend-pevo-string-helper-adoption-sweep"

  Convention `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` was filed 2026-05-15; this commit landed 2026-05-07 (8 days pre-convention). Per learnings researcher, "Comments authored before 2026-05-15 are pre-convention; round-2 fixes are the first opportunity to apply this rule" — but the codebase has an active `backend-comment-anchor-sweep-*` task series whose explicit purpose is picking up exactly this rot class. Grandfathered per timing; the comment-anchor sweep series picks these sites up on its next pass. Will be noted in the eventual archive entry.

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-05-21, round-3, commit `9ea7aa82`)

All 3 round-3 hold items landed in one commit. Production code unchanged; only test files edited (plus one new follow-up task file in `tasks/pending/`).

- **Item 1 — `language: ''` docblock parity framing.** `continuation-author-gate.test.ts` — docblock for the `language: ''` spec rewritten. Pre-migration `pevo.language || 'en'` and post-migration `pevoString(pevo, 'language') ?? 'en'` both return `'en'` for empty-string input. Framing now correctly states parity, not behavioral upgrade. Category error around "truthy for `??`" removed. Assertion unchanged.
- **Item 2 — `(real HAF)` describe label + clause-(c) citation.** `reviews.test.ts` — `(real HAF)` describe block relabeled to `(mocked-pool: 404 path)`; file-header clause-(c) framing rewritten to acknowledge no real-path companion exists today. Picked architect's option (b): filed follow-up task `backend-reviews-real-haf-integration-coverage.md` under `tasks/pending/` capturing the gap. The new task file is committed in the same commit; header reference points at `agents/docs/tasks/` generically rather than embedding the slug (slug rots on archive per the comment-anchor conventions).
- **Item 3 — raw line-number anchors.** Only `reviews.ts:30` (in `reviews.test.ts`) remained in current source at the time of fix; the two `papers.ts:1749` / `papers.ts:1757` parenthetical citations and the `sed -n '30p'` verification line had already been removed by intervening comment-anchor-sweep commits in the period between round-2 landing and this fix. Replaced `reviews.ts:30` with the stable-symbol anchor `buildReviewDetail` projection. Verified at fix time: `buildReviewDetail` lives in `backend/src/routes/reviews.ts`, the migrated `pevoString` call is inside its body.

Self-audit on added lines: no new task-slug citations, no round-N markers, no line-number anchors, no SHA refs, no date anchors, no relative positional anchors. Existing grandfathered citations (per architect's "no implementer action — grandfathered" note in the round-2 hold) left untouched; the in-flight `backend-comment-anchor-sweep-*` series picks them up.

Verification: `npx tsc --noEmit` clean. `npx vitest run tests/routes/continuation-author-gate.test.ts tests/routes/reviews.test.ts` — `continuation-author-gate.test.ts` 51/51 pass; `reviews.test.ts` 6/8 pass (2 pre-existing failures in the `SQL accreditation gate` describe block also present on a `git stash`'d baseline; unrelated to this hold-block scope; flagged for parent to triage separately).


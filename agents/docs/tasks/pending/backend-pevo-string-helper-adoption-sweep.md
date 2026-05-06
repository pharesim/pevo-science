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

## Backend re-review signal block (round-1 implementation, 2026-05-06)

**Worker:** Backend worktree subagent (worktree-agent-a1a77443470f43d4d, rebased onto main 89ec691 before editing)

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

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

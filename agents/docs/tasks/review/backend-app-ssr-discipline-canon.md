# BE-APP-SSR-DISCIPLINE-CANON — Route SSR JSON-LD `about` field through `paperDisciplineField()`

**Owner:** backend
**Created:** 2026-04-28 (surfaced by BE-PROFILE-PAPER-DISCIPLINE-CANON review, maintainability reviewer P2 conf 85)
**Priority:** P2

## Context

The discipline-canon cluster (BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME, BE-PROFILE-PAPER-DISCIPLINE-CANON) routed every per-paper `discipline` field on the **API surface** through the helper `paperDisciplineField(raw: unknown): string | null` at `backend/src/types/disciplines.ts`. The helper's docstring at lines 152-154 explicitly claims:

> Every response-shaping site that surfaces a paper's discipline must route through this so future drift becomes a type-check failure at the helper call site, not a whack-a-mole across routes.

One bypass exists today: the SSR JSON-LD construction at `backend/src/app.ts:347`:

```ts
jsonLd.about = pevoMeta.discipline;
```

This emits the raw on-chain casing into the `<script type="application/ld+json">` block embedded in the SSR HTML payload. Schema.org `about` is the structured-data field academic indexers consume (Google Scholar, Semantic Scholar, OpenAlex, etc.). After the cluster lands, `/api/papers`, `/api/papers/:author/:permlink`, and `/api/profile/:account/papers` all return canon-lowered disciplines while the SSR JSON-LD on the same paper's HTML page emits the raw on-chain casing.

That asymmetry is the exact "whack-a-mole" failure mode the helper exists to prevent.

## Reproduction

For a paper whose on-chain `pevo.discipline` is `'Computer Science'` (mixed case) or `'  Theoretical Physics  '` (whitespace-padded):

```bash
# API path (canon-lowered after cluster):
curl -s "http://localhost:3001/api/papers/<author>/<permlink>" \
  | jq '.data.discipline'
# → "computer science"

# SSR HTML path (raw on-chain casing today):
curl -s "http://localhost:3001/papers/<author>/<permlink>" \
  | grep -oE '"about":\s*"[^"]*"'
# → "about": "Computer Science"   (or "  Theoretical Physics  ")
```

External indexers fingerprinting disciplines by exact-string match see two different values for the same paper depending on which surface they crawl.

## Goal

1. Route the JSON-LD `about` field at `backend/src/app.ts:347` through `paperDisciplineField(pevoMeta.discipline)`.
2. Decide whether `null` (helper return for missing/empty/non-string) should:
   - **Option A:** Coalesce to the empty string `''` (preserves the field's presence; matches the `toPaperSummary` coalesce-at-boundary pattern from BE-PROFILE-PAPER-DISCIPLINE-CANON).
   - **Option B:** Omit the `about` field entirely from the JSON-LD object when the discipline is absent (schema.org-cleaner; absent fields are valid in structured data).
   Recommendation: **option B** (omit when absent). Schema.org structured-data consumers prefer absent fields to empty-string fields; an empty `about` is semantically wrong (the paper is "about" nothing). The API-side coalesce-to-`''` exists to preserve a non-nullable `PaperSummary.discipline: string` typing, which is an API-shape concern that doesn't apply here.
3. Run a one-time grep audit across `backend/src/` to find any **other** sites reading `pevo.discipline` / `meta.discipline` / `paper.discipline` / `bridgePaper.discipline` (or similar) into a response-shaping context that bypass the helper. Per the wrapping-primitive learning at `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`, this audit is the structural-rather-than-whack-a-mole closure of the helper's "every site" claim. List findings in the task signal block. Surfaces explicitly out of scope: bridge.ts:351 (on-chain write, NOT a response-shaping site — see cluster review dismissal).

## Non-goals

- Changing the helper's signature or canon semantics.
- Migrating the publish/edit-side normalization (already normalized via `normalizeDiscipline`).
- Bridge.ts:351 cast cleanup (architect-dismissed cluster-wide as P3 cosmetic, on-chain-write context, single-site below file-creation threshold).
- Front-of-mind unaddressed audit findings beyond response-shaping bypass — this task is the response-shape closure, not a wider type-honesty sweep.

## Acceptance

- `backend/src/app.ts:347` no longer reads `pevoMeta.discipline` directly. The JSON-LD `about` field is either canon-lowered via `paperDisciplineField()` or absent (per chosen option).
- A test (mocked-pool acceptable per the carve-out, with justification in the file header) seeds a paper with `pevo.discipline = '  Computer Science  '` and asserts the SSR HTML's JSON-LD `about` is `'computer science'` (option A) or absent (option B).
- The audit grep result is documented in the task signal block. Any additional bypasses found are either fixed in this same commit or filed as separate tasks with their reasoning.

## Tests

- **Mocked-pool spec** in `backend/tests/routes/` (a new file alongside `app-ssr.test.ts` if one exists, or a new describe block in the closest sibling). The carve-out justification: SSR JSON-LD generation is paired with the route handler; testing it via real-HAF is feasible but more brittle than seeding a paper-shape through the same helper used by `/api/papers/:author/:permlink` SSR path. Pick the lighter shape that pins the canon transform deterministically.
- Header-level documentation: add a one-line header bullet to whatever test file holds the new spec, citing this task and the SSR-vs-API parity rationale.
- Real-HAF parity check (if practical): a paper whose on-chain discipline is mixed-case + whitespace-padded would render canon-lowered in the SSR JSON-LD. Vacuous on the current corpus (verified all-lowercase per ARCHITECT-DISCIPLINE-FILTER-PUBLISH-CHARSET-ALIGNMENT audit), so the mocked-pool spec is the load-bearing regression net.

## Coordination notes

- The architect's `agents/docs/api-contracts/` files do not currently document SSR JSON-LD shape (the contracts cover API JSON responses, not server-rendered HTML payloads). No api-contract update needed for this task. If the architect wants SSR JSON-LD documented in a contract file, that's a separate scope decision.
- The wrapping-primitive learning (`agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`) is the named precedent for the audit-grep step. Cite it in the signal block.

## Backend signal block (2026-04-28, working tree → commit pending)

**Decision:** Option B (omit `about` when `paperDisciplineField()` returns null). Schema.org structured-data consumers prefer absent fields to empty-string fields; an empty `about` is semantically wrong (the paper is "about" nothing). The API-side coalesce-to-`''` exists to preserve `PaperSummary.discipline: string` typing — that's an API-shape concern that doesn't apply to schema.org JSON-LD.

**Implementation:**
- `backend/src/app.ts` — added `import { paperDisciplineField } from './types/disciplines.js';` and replaced `if (pevoMeta.discipline) jsonLd.about = pevoMeta.discipline;` with a `paperDisciplineField(pevoMeta.discipline)` route through. The replacement omits `about` for null/whitespace-only/non-string inputs (Option B).
- Brief inline comment on the new branch points at the helper rationale and the omit-vs-empty-string decision (no full doc dump — the helper docstring is the source of truth).

**Tests:** `backend/tests/routes/app-ssr-discipline-canon.test.ts` (new file). Header documents the SSR-vs-API parity rationale and the mocked-pool carve-out justification (the canon transform fires deterministically only when on-chain values are mixed-case or whitespace-padded; the current corpus is all-lowercase per ARCHITECT-DISCIPLINE-FILTER-PUBLISH-CHARSET-ALIGNMENT, so a real-HAF assertion would be vacuous on the metric we care about). Four cases:
1. `'  Computer Science  '` → `about === 'computer science'`
2. discipline absent → `about` omitted
3. discipline whitespace-only (`'   '`) → `about` omitted
4. discipline non-string (`42`) → `about` omitted

`hiveClient.database.call('get_content', ...)` is the single mock; `verifyHiveSignature` and other middleware are NOT mocked (the SSR catch-all is unauthenticated). All 4 tests pass.

**Audit grep result** (per `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`):

```
$ grep -rn "\.discipline" backend/src/ --include="*.ts" | grep -v "src/types/disciplines.ts"
src/app.ts:347                  ← bypass FIXED in this commit
src/helpers.ts:118              ← already routes through paperDisciplineField (toPaperSummary)
src/routes/papers.ts:391        ← already routes through paperDisciplineField
src/routes/papers.ts:591        ← already routes through paperDisciplineField
src/routes/papers.ts:983        ← already routes through paperDisciplineField
src/routes/search.ts:320        ← uses validateDisciplineFilter (security-guard helper, not the response-shape helper — different concern, correctly out of scope)
src/routes/bridge.ts:351        ← on-chain write context, explicitly out of scope per task non-goals + cluster review dismissal
src/helpers.ts:116              ← comment, no .discipline access
```

After this fix, every response-shaping site reading `pevo.discipline` / `meta.discipline` / `paper.discipline` / `bridgePaper.discipline` routes through `paperDisciplineField()`. The helper's "every site" docstring claim now structurally holds. No additional bypasses found; nothing filed as a follow-up.

**Linting:** `npm run lint` clean (2 pre-existing warnings in `seed-phrase.ts`, unrelated).

**Coordination:** No `agents/docs/api-contracts/` change needed — the contract files cover JSON API responses, not server-rendered HTML payloads. SSR JSON-LD is not currently documented in any contract file; if the architect wants it documented, that's a separate scope decision (called out in the task's Coordination notes).

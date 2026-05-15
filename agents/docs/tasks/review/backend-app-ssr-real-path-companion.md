# BE-APP-SSR-REAL-PATH-COMPANION — Real-path SSR smoke test for `/en/paper/:author/:permlink` JSON-LD emission

**Owner:** backend
**Created:** 2026-05-15 (surfaced by BE-APP-SSR-DISCIPLINE-CANON `/ce-code-review`, testing+project-standards joint finding anchor 100, clause-c gap)
**Priority:** P3

## Context

`backend/tests/routes/app-ssr-discipline-canon.test.ts` mocks `hiveClient.database.call` and pins the canon-lowering transform across four discipline shapes (mixed-case + whitespace-padded → `'computer science'`; absent / whitespace-only / non-string → `about` omitted). The file header invokes the test-mock carve-out (`agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`) and satisfies clauses (a) "name the impractical real path" and (b) "auth middleware runs real unless test focus is downstream" (the SSR catch-all is unauthenticated, so `verifyHiveSignature` is trivially out of scope).

Clause (c) — "the same risk class is covered by a real-path test elsewhere, OR a follow-up task is filed to add such coverage" — is not yet satisfied. The corpus-vacuousness argument ("Real-HAF parity check vacuous on the current all-lowercase corpus per ARCHITECT-DISCIPLINE-FILTER-PUBLISH-CHARSET-ALIGNMENT") explains why a mixed-case real-HAF assertion would be uninformative for the transform-logic mutation class, but it does not address the **wiring mutation class** that the mocked test cannot catch:

- `import { paperDisciplineField } from './types/disciplines.js';` reverted
- the `if (canonDiscipline) jsonLd.about = canonDiscipline;` branch short-circuited or replaced
- the helper call replaced with raw `pevoMeta.discipline` (re-introduction of the bypass this task closed)
- the SSR catch-all route never reaching `injectPaperMeta` at all

A real-path test that issues an HTTP GET to `/en/paper/:author/:permlink` against a real Hive API + HAF setup with an existing all-lowercase corpus paper would exercise the integrated SSR emission path. It does not need to re-assert the canon transform (the mocked test pins that); it only needs to assert that the ScholarlyArticle JSON-LD block is present in the HTML response and that `about` matches the on-chain value verbatim (for lowercase corpus data, raw == canon-lowered, so a single equality assertion suffices). That assertion goes red if the helper call is bypassed and the production code starts emitting raw on-chain values that happen to differ from the expected canonical form in any way (whitespace, casing).

This task files that follow-up per clause (c).

## Goal

Add a real-path SSR smoke test that:

1. Picks an existing real paper on the configured HAF instance whose `json_metadata.<appTag>.discipline` is a non-empty string.
2. Issues `GET /en/paper/:author/:permlink` against `createApp()` with real `hiveClient` and real HAF (no mocks).
3. Extracts the first `<script type="application/ld+json">` block from the HTML response.
4. Asserts `jsonLd['@type'] === 'ScholarlyArticle'` and `jsonLd.about === paperDisciplineField(raw_chain_discipline)` where `raw_chain_discipline` is fetched in the same test via a sibling `hiveClient.database.call('get_content', …)` call so the expected and actual values share a source of truth.

The mocked test is the load-bearing regression net for the canon-lowering transform; this companion is the load-bearing regression net for the SSR-emission wiring.

## Non-goals

- Re-asserting the four mocked cases (absent / whitespace / non-string / mixed-case) — those are pinned by the existing mocked file.
- Backfilling a mixed-case paper on-chain just to make the real-path assertion non-vacuous on the canon transform. The corpus is all-lowercase by design (per ARCHITECT-DISCIPLINE-FILTER-PUBLISH-CHARSET-ALIGNMENT); this companion exercises the wiring axis, not the transform axis.
- Restructuring the existing mocked test.

## Acceptance

- New test file (or new describe block in an existing real-HAF SSR test file, if one exists) under `backend/tests/routes/`.
- The test runs without mocks against the real HAF + Hive API.
- A wiring mutation (drop the `import`, replace the helper call with raw `pevoMeta.discipline`, short-circuit the branch) makes the real-path test fail.

## Tests

- One real-path `it` block is sufficient. The mutation-kill criterion above is the regression value; multi-paper coverage adds maintenance cost without catching additional mutation classes.

## Coordination notes

- The existing mocked file's header at `backend/tests/routes/app-ssr-discipline-canon.test.ts` lines 1-27 can be updated by the implementer (in the same commit that lands this companion) to cite the companion file under clause (c). Until that happens, the carve-out paperwork is incomplete but functionally satisfied by this filed task.
- `paperDisciplineField` is at `backend/src/types/disciplines.ts:171` (canon-lower + trim, returns `string | null`).
- SSR handler is `injectPaperMeta` in `backend/src/app.ts:317-377` (helper-routed at `:355`).

---

## Implementer signal (2026-05-15, commit `b71e3c6` on `main`) — round 1

Landed the real-path SSR JSON-LD wiring companion as `backend/tests/routes/app-ssr-discipline-real-path.test.ts` (128 lines). The test walks `/api/papers` for an existing paper with a non-empty discipline, fetches the raw post via the same `get_content` call site `injectPaperMeta` uses, then asserts the SSR `ScholarlyArticle.about` equals `paperDisciplineField(raw_chain_discipline)`. A single equality assertion suffices for the current all-lowercase corpus (raw == canon-lowered).

Catches the wiring mutation class the mocked test cannot:
- `paperDisciplineField` import reverted
- `if (canonDiscipline) jsonLd.about = canonDiscipline;` short-circuited or replaced
- helper call replaced with raw `pevoMeta.discipline`
- SSR catch-all never reaching `injectPaperMeta`

Uses the established sibling skip-on-empty-corpus / null-discipline / malformed-json_metadata pattern from `papers.test.ts` for degenerate states.

Also updated `backend/tests/routes/app-ssr-discipline-canon.test.ts` header to cite the companion under clause (c) per the task's coordination note.

The mocked test stays load-bearing for the transform-axis mutation class; this companion covers the orthogonal wiring-axis class per the architect's clause-c refresh at commit `41ebc5b`.

The `git mv` to `tasks/review/` is the completion signal.

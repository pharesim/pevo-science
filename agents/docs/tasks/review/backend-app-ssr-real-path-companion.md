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

Catches the wiring-bypass mutation class the mocked test cannot:
- `paperDisciplineField` import reverted
- `if (canonDiscipline) jsonLd.about = canonDiscipline;` short-circuited or replaced
- SSR catch-all never reaching `injectPaperMeta`

Helper-self-mutation (raw `pevoMeta.discipline` bypass, transform regressed) stays with the mocked sibling — the all-lowercase corpus invariant makes raw == canon, so this companion's equality assertion is blind to that mutation class.

Uses the established sibling skip-on-empty-corpus / null-discipline / malformed-json_metadata pattern from `papers.test.ts` for degenerate states.

Also updated `backend/tests/routes/app-ssr-discipline-canon.test.ts` header to cite the companion under clause (c) per the task's coordination note.

The mocked test stays load-bearing for the transform-axis mutation class; this companion covers the orthogonal wiring-axis class per the architect's clause-c refresh at commit `41ebc5b`.

The `git mv` to `tasks/review/` is the completion signal.

---

## Architect re-review (2026-05-15) — HELD PENDING FIXES (round 1)

`/ce-code-review` ran on commit `b71e3c6` (round-1 implementation) with 5 personas (correctness, testing, maintainability, project-standards, reliability). Test wiring lands correctly for 3 of the 4 claimed mutations (helper-import revert, branch short-circuit, catch-all bypass — all caught by the integrated `expect(jsonLd!.about).toBe(expectedAbout)` assertion at line 125). But the fourth claimed mutation is not actually killed on the current corpus, and both test headers plus the task body's enumeration overstate coverage. One P1 hold item; other findings dismissed at user triage.

### Items to address

**1. (P1) "helper call replaced with raw `pevoMeta.discipline`" mutation is NOT caught on the all-lowercase corpus**

- Cross-reviewer convergence: correctness-3 (P3 conf 50) + testing-001 (P1) → anchor 75 after promotion. Severity P1.
- Files: `backend/tests/routes/app-ssr-discipline-real-path.test.ts:125` (the load-bearing assertion); claimed-kill text at `:14-22` (real-path file header); `backend/tests/routes/app-ssr-discipline-canon.test.ts:22-29` (mocked-sibling header added in this same commit); mutation-kill enumeration at lines 62-66 of THIS task body.
- `paperDisciplineField` at `backend/src/types/disciplines.ts:171` is `trim + lowercase`. For the current all-lowercase corpus, raw chain value === canon-lowered value. If the production code at `backend/src/app.ts:355-356` is mutated to emit raw `pevoMeta.discipline` instead of calling `paperDisciplineField(...)`, the SSR output equals the test's expected value, and `expect(jsonLd!.about).toBe(expectedAbout)` passes green. The mutation is not killed.
- The task body acknowledges this corpus invariant on line 18 ("For lowercase corpus data, raw == canon, so a single equality assertion suffices") but the headers and the enumeration still claim the bypass mutation is killed. Restore consistency between rationale and claimed coverage.
- Fix shape: drop "helper call replaced with raw `pevoMeta.discipline`" from BOTH (a) the real-path test header's claimed-kill list at lines 14-22, AND (b) the mocked-sibling header's claimed-kill list at canon test lines 22-29, AND (c) this task body's mutation-kill enumeration at lines 62-66. Reframe the test as wiring-bypass-only coverage (assignment to `jsonLd.about` exists; helper presence by trace; catch-all reach). The mocked sibling already pins the transform-axis mutation class (canon-lowering across mixed-case/whitespace/non-string shapes); explicitly defer helper-self-mutation coverage to it. Mechanical edit — purely descriptive, brings the claim into line with what the test actually catches.

### Items dismissed during architect triage (do NOT address)

- **JSON-LD regex `[^<]+` truncates if JSON body contains `<`** (correctness-1, P2 conf 75) — accepted as a false-positive risk; corpus is small enough that `<` in titles is unlikely, and the test errors loudly rather than silently passing.
- **Verbatim `extractJsonLd` duplicated between canon and real-path tests** (maintainability MAINT-001, P2 conf 75) — pure dedup without functional improvement; the sibling helper pre-existed and the new test conformed to the established pattern.
- **Skip-as-pass anti-pattern: 3 silent `return`s** (4-reviewer convergent finding, P3 anchor 100 after promotion) — pattern matches sibling `papers.test.ts:195,216` (established project convention); flipping it in this file alone would break consistency. If the convention should change project-wide, that's a separate testing-convention task, not a hold-block item.
- **Inline `/api/papers` response shape duplication, listing reads only page 1, concurrent corpus mutation hazards** (maintainability + reliability, all P3 anchor 50) — below gate; acceptable for the test's scope.

### Re-review signal

When item 1 lands, `git mv` this file from `tasks/pending/` back to `tasks/review/`. The move itself is the re-review signal.

---

## Backend re-review signal (2026-05-15, working tree) — round 2

Item 1 landed. Three documented locations now describe the test as wiring-bypass-only coverage and explicitly defer helper-self-mutation to the mocked sibling:

- `backend/tests/routes/app-ssr-discipline-real-path.test.ts` header (lines 14-21 in the new shape): drops "the helper call being replaced with raw `pevoMeta.discipline`" from the wiring enumeration, renames it "wiring-bypass mutation class", and adds a paragraph naming the helper-self-mutation class as out-of-scope and pinned by the mocked sibling.
- `backend/tests/routes/app-ssr-discipline-canon.test.ts` clause-c companion paragraph: drops "raw `pevoMeta.discipline` bypass" from the companion's claimed-kill list and adds a sentence asserting the helper-self-mutation class stays here.
- This task body's mutation-kill enumeration (above): drops the third bullet and adds the corpus-invariant deferral sentence.

Also touched the inline assertion comment in the real-path test (around the load-bearing `expect(jsonLd!.about).toBe(expectedAbout)`) — same overstatement, same fix, called out here for transparency. The architect's hold-block enumerated only the file/sibling headers and the task body, but the inline comment carried the same false claim and was inconsistent with the corpus-invariant rationale. Easier to bring it into line now than ship a third round.

No code changes — purely descriptive. The test still asserts `expect(jsonLd!.about).toBe(expectedAbout)`; the assertion's load-bearing mutation classes are now described accurately.

The `git mv` to `tasks/review/` is the re-review signal.

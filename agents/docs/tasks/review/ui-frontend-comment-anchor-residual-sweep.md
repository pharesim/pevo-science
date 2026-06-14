# UI-FRONTEND-COMMENT-ANCHOR-RESIDUAL-SWEEP — clear pre-existing comment-anchor rot in frontend/src + frontend/tests

**Owner:** ui
**Created:** 2026-06-14 (architect, from the `/ce-code-review` re-review of the consent-affordances + credit-op-cache delivery; project-standards + adversarial, P3)
**Priority:** P3 (durability hygiene; no behavioral impact)

## Problem

The consent-affordances delivery cleaned comment-anchor rot in the files it
rewrote, but the review found pre-existing anchor-rot residuals in `frontend/`
that predate that work and were not in its sweep scope. Per root `CLAUDE.md`
"Comment anchors", production AND test code must not cite task slugs, round
numbers, acceptance numbers, line numbers, or commit SHAs — task files archive
into `tasks-archive.md` (trimmed at 250 lines) so the citation becomes a dead
pointer. Known residuals (confirm and treat as a starting set, not exhaustive):

- `frontend/tests/unit/pages-orcid-callback.test.js` header — cites the task slug
  `ui-multi-author-consent-affordances` and a "the task file's acceptance §4"
  redirect.
- `frontend/tests/unit/pages-paper-detail.test.js` — cites
  `UI-COAUTHOR-CONTINUATION-PUBLISHING round-2 item 1` (slug + round).
- `frontend/src/pages/orcid-callback.js` — cites `BE-ORCID-BROADCAST-ABORT-TIMEOUT`.

## Goal

Re-anchor every comment-anchor-rot citation in `frontend/src/**` and
`frontend/tests/**` on stable behavior/symbols, preserving any load-bearing WHY.

## Acceptance

- A FULL enumeration first, not just the three cited sites. Grep `frontend/src`
  and `frontend/tests` for ALL rot classes and ALL slug prefixes — do NOT narrow
  to one prefix or one case. Cover at minimum:
  - Task slugs: uppercase (`UI-`, `BE-`, `SEC-`, `BACKEND-`) AND lowercase
    `<role>-<kebab>` (`ui-…`, `backend-…`).
  - Round / hold / item ordinals ("round-2", "round-3 hold item 1", "Option A.1").
  - Acceptance-number citations ("Acceptance #4", "§4").
  - Line-number and commit-SHA cross-references.
  - Soft redirects: "see the task file", "per the task", trailing `.md` pointers.
- Each citation re-anchored on a stable symbol (exported function, Alpine binding,
  route/handler name) or on behavior, with load-bearing WHY preserved.
- The replacement text must not introduce a new rot class (a slug swapped for a
  line number, etc.) — audit the replacement against every rule above.
- Durable `agents/docs/solutions/*` and `agents/docs/api-contracts/*` references
  are legitimate anchors and are KEPT.
- No production or test behavior changes; comment-only diff.

## Cross-references

- Root `CLAUDE.md` "Comment anchors".
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-06-14) — HELD PENDING FIXES:

`/ce-code-review` on `bbe6607c` (correctness on the session model; testing,
maintainability, project-standards, learnings on Sonnet; ce-agent-native skipped
per PEvO) confirmed the DIFF is clean: mechanically comment-only (non-comment
content byte-identical across all 52 files), every re-anchor lands on a stable
symbol/behavior, no new rot class introduced, load-bearing WHY preserved. The
problem is COMPLETENESS — acceptance criterion #1 ("a FULL enumeration first")
was not met. The sweep's enumeration grep under-enumerated prefix families (it
caught `UI-`/`BE-`/`SEC-`/`BACKEND-` but missed `JFR-`, `TEST-`, and the soft
`See task ITEM N` redirect), so it left in-scope comment-rot in files outside its
own diff — including two production-source sites where the matching TEST sibling
WAS swept (the documented `convention-sweep-syntactic-form-misses-semantic-siblings`
failure mode). Re-anchor these and move the file back to `review/`:

1. **`frontend/src/pages/search.js` (PRODUCTION) — `JFR-001` review-finding cite.**
   `See JFR-001.` (in the `_searchController` docblock) and `Cancel-on-new guard
   (JFR-001)` (in the trimmed-query path) cite a code-review finding ID with no
   durable home. The surrounding prose already states the invariant (abort the
   prior in-flight `doSearch` so stacked requests cannot last-arrival-wins-overwrite
   the visible results). Drop the `JFR-001` tokens; keep the behavioral text. The
   test sibling `pages-search.test.js` already had `JFR-001` swept in this commit
   — this is the source half that was missed.

2. **`frontend/src/lib/accredited-directory.js` (PRODUCTION) — `See task ITEM N`.**
   The `applyHiveChangePrefill` case comments end with `See task ITEM 9.` /
   `See task ITEM 1.`, and the `applyDirectoryPrefill` (array reapply) docblock
   ends with `See task ITEM 2.` — soft task-redirect + item-ordinal. The numbered
   case prose (1/2/3) already IS the behavioral anchor; just drop the trailing
   `See task ITEM N.` sentences. This whole file was outside the sweep.

3. **`frontend/tests/unit/pages-settings.test.js` — `This is AC #3's …`.**
   In the `destroy() wipes sensitive upgrade state` test's lead comment: an
   acceptance-number cite into an archived task. Drop `This is AC #3's`; keep the
   quoted behavioral phrase ("surface the unmount as an explicit cleanup signal").
   One missed site in a file the sweep otherwise touched.

4. **`frontend/tests/e2e/bridge-preview.spec.js` — `bridge.js L66` line cite.**
   `Authors … joined with ", " by the template (bridge.js L66).` Re-anchor on the
   template behavior (e.g. "joined with ', ' by the bridge-preview author
   template"); drop the `L66`.

5. **`frontend/tests/e2e/fixtures/keychain.js` + `global-setup.js` — coordination-ID
   redirects in comments.** keychain.js cites `See TEST-003 …` and `… smoke test
   from SEC-001`; global-setup.js cites `the backend-provided reset hook from
   TEST-001-BE`. `SEC-001` has a durable home — re-anchor that one on
   `sec-001-equivalence.test.js` (the keyless equivalence test). `TEST-003` and
   `TEST-001-BE` have no durable home — re-anchor on the behavior (the deterministic
   keyless Keychain-equivalence test; the backend DB-reset hook the global-setup
   invokes).

**Scope clarifications (so the re-sweep doesn't over- or under-reach):**

- **KEEP (not rot):** the self-describing E2E coverage-matrix header IDs
  (`E2E-AUTH-2 — Keychain challenge login`, and the `READ-N`/`WRITE-N`/`AUTH-N`/
  `CRYPTO-1`/`ACCR-1`/`BRIDGE-1`/`SETTINGS-1` one-per-spec header labels) and the
  `SEC-002`/`SEC-004` security-requirement IDs in spec headers. These are
  self-describing labels defined in place, not external redirects, so they do not
  rot into dead pointers. The original sweep kept them deliberately; leave them.
- **DEFER (out of scope here):** task-slug / round / item ordinals inside
  `describe()` / `it()` TEST-NAME strings (`FE-*`, `UI-PAPERS-ORCID-NULL-FALLBACK`,
  `UI-RETRY-UPGRADE-BACKEND-TEST-COVERAGE`, `SEC-004-UI`, `round-2 #N`, `item N`).
  The commit message documented this carve-out (re-labeling test names shifts
  CI/runner output, not a comment-only change). A separate follow-up may address
  test identifiers if wanted; do NOT fold it into this comment-only task.
- **FALSE POSITIVE (ignore):** `HJ-NP` matches are the base58 WIF character class
  `[1-9A-HJ-NP-Za-km-z]` in key-format regexes, not a slug.

Before re-submitting, run the WIDENED enumeration over `frontend/src/**` +
`frontend/tests/**` (all UPPERCASE `[A-Z]{2,}(-[A-Z0-9]+)+` coordination-ID
shapes, lowercase role-kebab, line/`LNN`/`~NNN` cites, `AC #`/`§` acceptance
cites, and soft `See task …` redirects), per
`agents/docs/solutions/conventions/sweep-acceptance-grep-under-enumerates-slug-prefix-families-2026-06-08.md`
— a narrow per-prefix grep is exactly what missed these. When the five items land,
`git mv` this file back to `tasks/review/`.

## UI re-review signal (2026-06-14, working tree) — re-sweep holds landed

All five held items re-anchored; comment-only diff (every added line is a
comment; non-comment content byte-identical). The widened enumeration over
`frontend/src/**` + `frontend/tests/**` (uppercase coordination-ID shapes,
lowercase role-kebab, line/`LNN`/`~NNN`/`AC #`/`§` cites, soft `see/this task`
redirects, trailing `.md`) surfaced no rot beyond the five plus one soft
`this task's contract` redirect, which was also re-anchored:

1. `src/pages/search.js` — dropped both `JFR-001` tokens; kept the
   abort-prior-in-flight-doSearch behavioral prose.
2. `src/lib/accredited-directory.js` — dropped the three `See task ITEM N`
   redirects; the numbered case prose carries the behavior.
3. `tests/unit/pages-settings.test.js` — dropped `This is AC #3's`; kept the
   "surface the unmount as an explicit cleanup signal" behavioral phrase.
4. `tests/e2e/bridge-preview.spec.js` — re-anchored `bridge.js L66` on the
   bridge-preview author template behavior.
5. `tests/e2e/fixtures/keychain.js` + `global-setup.js` — `SEC-001` re-anchored
   on the durable `sec-001-equivalence.test.js`; `TEST-003` / `TEST-001-BE`
   re-anchored on behavior (the keyless canonical-message equivalence test; the
   backend DB-reset hook). Plus `tests/e2e/publish.spec.js`: `this task's
   contract` -> `not asserted here`.

KEEP confirmed (untouched): spec-header `SEC-002`/`SEC-004` and coverage-matrix
labels, ARCHITECTURE.md `§6.5` invariant refs, durable `solutions/` /
`api-contracts/` `.md` refs, `sec-001-equivalence.test.js` file refs. DEFER
confirmed: task-IDs inside describe()/it() test-name strings. Replacements
audited against every rot class — no slug/line/SHA/ordinal reintroduced. Focused
unit suites green (pages-search, lib-accredited-directory, pages-settings: 156
passed); the four e2e files `node --check` clean.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

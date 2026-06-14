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

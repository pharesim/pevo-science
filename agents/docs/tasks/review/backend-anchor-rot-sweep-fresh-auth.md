# BACKEND-ANCHOR-ROT-SWEEP-FRESH-AUTH — sweep Round-N/hold comment anchors out of lib/fresh-auth.ts

**Owner:** backend
**Created:** 2026-06-09 (architect, from the `/ce-code-review` of `backend-authorship-credit-ops-fresh-auth`; kieran-typescript + maintainability + project-standards, P3)
**Priority:** P3 (convention hygiene; no behavior change)

## Problem

`backend/src/lib/fresh-auth.ts` carries roughly two dozen `Round-N hold #M` / `round-N` comment anchors in docblocks and inline comments (e.g. the `FreshAuthTarget` docblock, `computeFreshAuthTargetHash`, `isValidTargetHash`, the dual-tier consume comments, and many more). These violate the root `CLAUDE.md` "Comment anchors" convention: round/hold numbers lose meaning once the originating tasks archive, and the citations become dead pointers.

The credit-ops fresh-auth commit (`92f4b618`) already removed several such anchors on the lines it rewrote, which is why this is a standalone sweep rather than part of that feature task — the remaining anchors are pre-existing and pervasive, and fixing only the two a reviewer happened to cite would be arbitrary.

## Goal

Replace every `Round-N` / `hold #M` / `round-N` anchor in `backend/src/lib/fresh-auth.ts` with a behavioral description anchored on stable symbols (function names, the invariant the comment explains), per the convention. Do NOT cite task slugs, SHAs, line numbers, or section markers as the replacement — audit the replacement text for its own rot class (`convention-enforcing-fix-must-audit-its-own-new-code`).

## Acceptance

- `grep -nE 'Round-[0-9]|round-[0-9]|hold #' backend/src/lib/fresh-auth.ts` returns nothing.
- Each rewritten comment still conveys the invariant/rationale it documented, anchored on a stable symbol or the behavior itself.
- No replacement introduces a new rot class (slug / SHA / line-number / section-marker).
- Comment-only change: no source behavior change; `npm run typecheck` + `npm run lint` clean; the fresh-auth suites stay green unchanged.

## Notes

- Scope is `lib/fresh-auth.ts` only. Sibling files (`routes/custody.ts`, `routes/orcid.ts`) have their own anchors; a separate sweep already covered three of them. Keep this scoped to avoid colliding with in-flight credit-ops work in those files.
- Coordinate ordering with `backend-authorship-credit-ops-fresh-auth` (held): if that task is mid-flight in `fresh-auth.ts`, land the feature fixes first to avoid churn, then sweep.

## Cross-references

- root `CLAUDE.md` "Comment anchors"; `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-*.md`, `docblock-anchor-stable-symbols-not-line-numbers-*.md`, `convention-enforcing-fix-must-audit-its-own-new-code-*.md`.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend landing note (2026-06-09, commit `edc19a64`)

Swept all `Round-N` / `hold #M` / `round-N` comment anchors from `backend/src/lib/fresh-auth.ts`, re-anchoring each on stable symbols / behavioral descriptions. Also removed line-number anchors and a task-slug citation the sweep surfaced, and corrected two now-stale substantive phrasings. Comment-only; no behavior change. Acceptance grep `grep -nE 'Round-[0-9]|round-[0-9]|hold #' backend/src/lib/fresh-auth.ts` returns nothing (verified against current main). `npm run typecheck` + `npm run lint` clean; `fresh-auth.test.ts` green (53).

Ordering note: landed in the same batch AFTER the credit-ops fix (`89263220`), so the sweep also covers the credit-op code that change added to `fresh-auth.ts`. Review the two together (credit-ops first).

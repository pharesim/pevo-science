# BACKEND-ANCHOR-ROT-SWEEP-2026-05-21 — sweep leading-title task-slug prefixes on migrations 005/006/007 + sibling anchor rot in hafsql.test.ts

**Owner:** Backend Agent
**Created:** 2026-05-21 (architect, surfaced by `/ce-code-review` of the five-task auth/account-state review batch)
**Priority:** P2

## Problem

Two unrelated convention-rot clusters surfaced during the 2026-05-21 review of `backend-accounts-orcid-unique-constraint` and `backend-normalize-hive-account-adoption-sweep`. Both fall under root CLAUDE.md "Comment anchors" rules and the `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` + `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` conventions. Bundling them here so one focused PR closes both classes uniformly.

### Cluster A — Migration leading-title task-slug prefixes

Three migration files share the same title-prefix-slug shape on line 1:

- `backend/migrations/005_custody_audit_consent_ops.sql` line 1 — `BACKEND-CUSTODY-AUDIT-CONSENT-OPS — ...` (or equivalent; verify in-place)
- `backend/migrations/006_custody_audit_pii_annotation.sql` line 1 — `BACKEND-CUSTODY-AUDIT-PII-ANNOTATION — ...` (verify in-place)
- `backend/migrations/007_accounts_orcid_unique.sql` line 1 — `BACKEND-ACCOUNTS-ORCID-UNIQUE-CONSTRAINT — enforce 1:1 ORCID-to-account binding`

Each opens with the task slug as the leading-title prefix. Per the comment-anchor rules, task slugs in durable code (migration files are durable) rot when the task archives and drops off `tasks-archive.md`'s 250-line cap.

The architect call during the 2026-05-21 triage was to handle 005/006/007 uniformly rather than rewrite only 007 (which would create inconsistency across migration headers). The migration's filename + sequence number already provide the durable anchor; the comment's human-readable summary is decoration that should describe the change behaviorally.

### Cluster B — Sibling rot in `backend/tests/hafsql.test.ts`

The round-3 `backend-normalize-hive-account-adoption-sweep` review surfaced multiple pre-existing rot entries in the same file the round-3 sweep covered:

- File:line anchors in production-symbol docblocks (e.g., `papers.ts:NNNN`, `reputation.ts:NNN-NNN`) — line numbers drift
- Round-N hold-block citations in docblocks (`Round-2 hold #1 + round-3 hold #2 resolution`, `architect's round-3 resolution`, `round-2 hold-block prose`) — round numbers are a named rot class
- A `round-2 hold #1 tightening` round-N marker in a describe-block header docblock
- Soft slug-shaped redirects (`the task acceptance criteria`) that lose their referent on archive

The round-2 architect-note explicitly deferred these as "forward-looking comment-anchor sweep targets per the convention" rather than blocking the round-2 archive. This task carries the deferral through.

## Goal

Close both rot clusters in one focused PR so the convention is applied uniformly, with no per-round/per-task one-off rewrites.

## Acceptance

### Cluster A — Migration headers

1. **Rewrite the leading-title line of each migration** (005, 006, 007) to anchor on the behavioral change rather than the task slug. Examples (verify by reading each file's current behavior):
   - 007 today: `-- BACKEND-ACCOUNTS-ORCID-UNIQUE-CONSTRAINT — enforce 1:1 ORCID-to-account binding`
   - 007 proposed: `-- Migration 007: enforce 1:1 ORCID-to-account binding at the database layer`
   - 005/006: similar behavioral-anchor rewrite.

2. **Audit own replacement:** the new title text must not embed task slugs, round-N markers, SHA references, or line-number anchors. The migration's sequence number IS a durable anchor (file name); leading with `Migration NNN:` is fine.

3. **Forward note (optional, architect-zone):** consider appending one line to root CLAUDE.md "Comment anchors" or to `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` clarifying whether migration leading-title human-readable summaries are subject to the rule (current architect read: yes; migration file name is the durable key for the file itself, but the leading title is comment-class durable code). Implementer flags whether the doc update should land in this PR or be filed as a follow-up sweep.

### Cluster B — `backend/tests/hafsql.test.ts` rot

1. **Sweep every line-number anchor in production-symbol citations** (`papers.ts:NNNN`, `reputation.ts:NNN-NNN`, `hafsql.ts:NNN`, etc.). Replace with stable-symbol anchors (function name + behavioral statement). Per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`.

2. **Sweep every round-N marker** (`Round-2 hold #1`, `round-3 hold #2 resolution`, `architect's round-3 resolution`, `round-2 hold-block prose`, etc.) in docblocks and inline comments. Rewrite to anchor on the behavioral change being explained, not the coordination round.

3. **Sweep soft slug-shaped redirects** (`the task acceptance criteria`, `see the task body`, `per task X`). Replace with inline behavioral statements or stable cross-references to other production symbols / convention docs by stable name.

4. **Exhaustive in-file pass:** run `grep -nE "papers\\.ts:[0-9]|reputation\\.ts:[0-9]|hafsql\\.ts:[0-9]|round-[0-9]|task acceptance criteria|see the task" backend/tests/hafsql.test.ts` after the sweep and verify zero hits.

5. **Audit own replacement:** every rewrite must comply with the same rules — no new task slugs, no SHAs, no new line-number anchors, no new round-N markers.

### Verification

- `npx tsc --noEmit` from `backend/` — clean.
- `npm run lint` — clean.
- Targeted vitest runs: any test file touched should pass at parity with HEAD before the sweep (the rewrite is comment-only; no behavior changes).
- The post-sweep grep in Cluster B item 4 returns zero hits.

## Out of scope

- Other test files with sibling rot (e.g., `retract.test.ts`, `orcid.test.ts`). File separately if surfaced during a later review pass.
- Production-source comment rot beyond what surfaces during the in-file pass on `hafsql.test.ts`. The 2026-05-21 batch did not catalog production-source rot in the affected files; if the implementer finds adjacent rot in the SAME function/docblock being touched, fold it in (audit-own-replacement), but do not embark on a separate cross-file sweep.
- Migration files 001-004, 008+. The 2026-05-21 batch only flagged the 005/006/007 cohort; the architect's call was a cohort-uniformity decision, not a project-wide migration audit. Add later migrations to this convention by default on creation.

## References

- Root `CLAUDE.md` "Comment anchors" section
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
- 2026-05-21 architect-context `/ce-code-review` batch — surfaced by task-1 (project-standards + maintainability + learnings cross-corroborated on migration 007) and task-5 (maintainability cluster of 4 entries on `hafsql.test.ts`).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-05-26) — HELD PENDING FIXES:

`/ce-code-review` of the sweep commit `47009e53` (5 personas; correctness on Opus, testing/maintainability/project-standards/learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO) confirmed the sweep itself is clean: both acceptance greps return 0 hits, audit-own-replacement found no new rot-class anchors, every rewritten CTE/helper/file reference resolves to a real symbol, and the change is comment-only (33 passed / 2 skipped at parity). One finding is held for fix; one is dismissed.

1. **[HELD — P2] `backend/tests/hafsql.test.ts`, `excludeSelfReviewWhere behavioral matrix` docblock, axis 5 — inverted contract.** The axis-5 summary reads "Co-author with case-different hive name → admitted (the helper matches on exact string; case normalization is upstream — pin the contract to make future changes explicit)". The actual test (`self_review_by_uppercase_named_coauthor`, reviewer `bob`, paper author entry `{hive: 'Bob'}`) asserts that co-author is **excluded**, and the inline comment in the test body correctly explains the helper canonicalizes the broadcast hive via `LOWER(TRIM(...))` + the Hive-account charset regex itself (matching the JS-side `normalizeHiveAccount` wrapper). The docblock therefore states the inverted outcome and the wrong mechanism for a self-review-exclusion contract — and axis 5 is the one entry that explicitly claims to "pin the contract". The wrong text is pre-existing, but this sweep rewrote the same docblock's header to "Each axis below pins one admit/exclude outcome", which now vouches for an axis that pins the wrong outcome; per `comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20`, editing the docblock brings its accuracy into scope. Fix: rewrite axis 5 to state that a co-author with a case-different hive name is **excluded** because the helper canonicalizes via `LOWER(TRIM(...))` + charset regex before matching (mirror the accurate inline comment already in the test body). Audit-own-replacement: do not introduce a slug / SHA / line-number / round-N anchor in the replacement text.

Dismissed at triage (no action required): an over-long unwrapped comment line at `backend/migrations/007_accounts_orcid_unique.sql` in the Backfill-check block, introduced by this sweep (P3, cosmetic).

When the fix lands, `git mv` this file back to `tasks/review/` — the move is the re-review signal. Re-review will be scoped to the commits since this hold block.

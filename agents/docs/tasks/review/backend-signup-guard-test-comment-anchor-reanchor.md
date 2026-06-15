# Re-anchor pre-existing coordination-redirect comment in the ORCID-binding guard test (backend)

**Owner:** backend
**Created:** 2026-06-15

Spun off from the 2026-06-15 architect re-review of `backend-signup-confirm-orcid-binding-guard`
(maintainability finding, confidence 75; user-triaged "file follow-up" 2026-06-15).

## Problem

`backend/tests/routes/signup-verify-orcid-binding-guard.test.ts` carries a describe-block
comment (at the `/api/auth/confirm ORCID-binding guard` block) that reads:

> // /api/auth/confirm — the pending-signup-row repro from the task: a fresh
> // ORCID signup (pending row L) finalizing an ORCID already bound on chain to a
> // different account (self-custody B) must be refused with 409 ORCID_ALREADY_LINKED.

This is a soft coordination redirect that violates root `CLAUDE.md` "Comment anchors":
"from the task" points at a task file that archives (this very parent task archived
2026-06-15, so the pointer is already dead), and the bare `pending row L` / `self-custody B`
labels are repro-scenario labels meaningful only inside the now-archived task file.

It is the same rot class as the resolved hold item 1 of the parent task, but it is
PRE-EXISTING (introduced in `63ebde27`, NOT in the `e33384af` hold-fix commit), so it was
out of scope for that re-review's `e33384af`-scoped diff. The `.githooks/pre-commit` anchor
gate is diff-gated (added lines only) and its redirect regex requires the harder
`see task <slug>` form, so it does not catch this softer "from the task" phrasing on a
pre-existing line.

## Acceptance criteria

1. Re-anchor the comment on the stable behavioral scenario, dropping the "from the task"
   redirect and the bare `L`/`B` repro labels. State the scenario self-containedly, e.g.
   "a fresh ORCID signup (pending `accounts` row, no username yet) finalizing an ORCID
   already accredited on chain to a DIFFERENT (self-custody) account must be refused with
   409 ORCID_ALREADY_LINKED." Keep the behavioral WHY; lose the coordination pointer.
2. While there, grep the whole file once more for any other soft redirect / repro-label /
   ordinal residue and re-anchor any found (the re-review found only this one block, but
   confirm from the code, not from this note).
3. No behavior change; comment-only. `npm run typecheck` + `npm run lint` stay green.

## Out of scope

- No production-code or test-logic changes; this is a comment re-anchor only.
- The same-account-test discrimination note from the same review was DISMISSED (the
  cross-account sibling test provides guard-deletion discrimination; no whole-suite escape
  exists), so it is NOT part of this task.

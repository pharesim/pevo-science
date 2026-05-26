# BACKEND-REREVIEW-TEST-COMMENT-ACCURACY-FIXES — reword two stale/overclaiming test comments

**Owner:** Backend Agent
**Created:** 2026-05-26 (architect, consolidated from two `/ce-code-review` re-review findings)
**Priority:** P3

## Context

Two re-reviews surfaced conf-100 test-comment-accuracy defects that the reviewed commits themselves introduced. The production code in both is correct; only the comments are wrong. Bundled here because both are one-line comment rewords in `backend/tests/` (the architect cannot edit `backend/`, so these are handed to the backend agent). Both source tasks were archived clean on the code; this task tracks the comment cleanup only.

## Fix 1 — orcid-trim canary: sub-case (4) comment overclaims its mutation-kill scope

**File:** `backend/tests/routes/reputation-orcid-auto-accept-trim-canary.test.ts` (the sub-case (4) "negative control" comment, and the matching clause in the file docblock).

**What's wrong:** the comment claims the raw-`=` negative control "catches an inline call-site revert (replacing the helper call with a raw `=`) even if the helper is untouched." That is false. Sub-case (4) builds a hardcoded raw-`=` predicate inline and asserts non-match; it never references the production call site, so it always passes regardless of production state. A revert of `reputation.ts`'s call to `chainOrcidAutoAcceptMatchSql` to an inline raw `=` (helper body intact) leaves all four sub-cases green.

**What's true (and what the comment should say):** the canonical mutation the acceptance criterion names — reverting the BTRIM widening inside the `chainOrcidAutoAcceptMatchSql` helper body — IS caught, because sub-case (1) builds its predicate from the same helper (fix a). Sub-case (4) documents the BTRIM-vs-raw semantic contrast (the pre-fix failure mode); it is not a call-site mutation detector. Reword to state that accurately, dropping the "inline call-site revert is caught" claim.

## Fix 2 — smtp structural-lock docblock describes the pre-tightening grep

**File:** `backend/tests/lib/smtp-helper-exhaustive-call-sites.test.ts` (file docblock, the "grep matches comments as well as code" paragraph).

**What's wrong:** the docblock still says "The grep matches comments as well as code (`// nodemailer.createTransport` is still a hit) ... If a future doc-block in some other file mentions the bare phrase, that is also a violation." After the round-2 regex tightening to `(from|require\().*['"]nodemailer['"]`, the grep matches nodemailer *imports*, not bare comment text. A bare `// nodemailer.createTransport` comment in another file is NOT caught. The docblock now gives a false guarantee.

**What's true:** the lock now fires on any nodemailer import statement (ES or CJS) outside `src/lib/smtp.ts`, regardless of how `createTransport` is later referenced. Reword the docblock to describe the import-matching behavior; the describe/it titles that still say "nodemailer.createTransport" may be updated to "imports nodemailer" for accuracy but that is optional.

## Acceptance

1. Both comments reworded to match actual behavior; no remaining false guarantee or overclaim.
2. The reworded text introduces no new anchor rot (no task slugs, round numbers, line numbers, SHAs per CLAUDE.md "Comment anchors").
3. No production change; both touched files' targeted vitest stays green.
4. `npm run typecheck` + `npm run lint` clean on the touched files.

## References

- orcid-trim source commit: `b506bfd5` (round-4); the canary is `reputation-orcid-auto-accept-trim-canary.test.ts`.
- smtp source commit: `1dbbc69a` (round-2); the structural lock is `smtp-helper-exhaustive-call-sites.test.ts`.
- Both findings were conf-100, cross-reviewer (orcid-trim: correctness + testing; smtp: testing).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

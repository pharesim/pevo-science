---
title: "Carve-out clause-(c) companion citations are unverified prose: resolve the path and grep the risk-class token, at write time and at review"
date: 2026-09-02
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: high
related_components:
  - documentation
  - development_workflow
  - authentication
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - "Authoring a test-file header that invokes the root CLAUDE.md mock carve-out and names a clause-(c) real-path companion"
  - "Reviewing a task whose diff adds or edits a carve-out header, and deciding whether clause (c) is satisfied"
  - "Answering step 3 of the reviewer checklist in test-mock-carve-out-clause-c-2026-05-04.md (does a real-path test elsewhere catch the same failure mode)"
  - "A carve-out header points at a CATEGORY of suites (the settings password-reset suites, the recover tests) instead of a specific test file path"
  - "Renaming, splitting, or deleting a test file, or weakening an assertion that a mocked sibling may cite as its companion"
  - "Sweeping a prose class (docblock claims, companion citations) across a test tree"
symptoms:
  - "`grep -c reissuedAt backend/tests/routes/recover.test.ts` returns 0 for the file cited as the reissuedAt real-path companion"
  - "Two middleware carve-out headers name a category of suites as the live SESSION_INVALIDATED companion; grep finds that code in six files, none of them a settings-* suite"
  - "The true companion declares itself the clause-(c) real-path companion in its own header while two other files point elsewhere"
  - "A review persona returns clean with all cited real-path companions verified to exist, having checked existence rather than truth"
tags:
  - test-mocks
  - carve-out
  - real-path
  - clause-c
  - testing-convention
  - comment-rot
  - docblock
  - coverage-verification
---

# Carve-out clause-(c) companion citations are unverified prose

## Context

Root `CLAUDE.md` ("Carve-out for deterministic edge-case coverage") permits targeted mocking in tests under three clauses. Clause (c) requires that the same risk class be covered by a real-path test elsewhere, or that a follow-up task be filed to add such coverage.

In this repo the compliance artifact for clause (c) is a sentence in the mocked test file's own header docblock, naming the companion. That sentence is free prose. Nothing verifies that the named file exists, and nothing verifies that it asserts anything in the claimed risk class. The citation is checked by exactly one mechanism: a human or an agent reading it and believing it.

The same falsehood has now been found in three separate headers across two incidents, and this is its second write-up. `coverage-claim-downgrade-requires-codebase-search-2026-05-21.md` documents the first incident: a mocked SQL-shape test named `notifications.test.ts` as its real-`verifyHiveSignature` companion, and that file hoists the `MOCK_VERIFY_SIGNATURE` fixture throughout, so it mocked the very surface it was cited for covering. That entry prescribed a manual four-step search, scoped to the moment an architect hold-block asks for a claim to be downgraded. The procedure was in force from that date, and two further false citations were nonetheless sitting in the `verifyHiveSignature` suites when they surfaced on 2026-09-02. A convention that has now failed three times in one artifact class is the standard trigger in this repo for mechanizing it, which is the argument `comment-anchor-rot-precommit-diff-gate-2026-06-14.md` makes for the anchor conventions.

`test-mock-carve-out-clause-c-2026-05-04.md` settled what clause (c) **means** (risk-class equivalence, never literal-mirror) and supplied the reviewer checklist whose step 3 asks "Does a real-path test elsewhere catch the same failure mode?". This entry does not reopen that. It addresses the precondition sitting upstream of it: **equivalence can only be judged once the cited companion is confirmed to exist and to contain the risk class.** A reviewer who answers step 3 by reading the mocked file's header gets whatever the header says, which may be a claim about a file that stopped being true, or about a suite that never existed.

Both live counterexamples sat in headers that were otherwise exemplary: full clause (a) justification, an explicit clause (b) statement that the middleware is not mocked, named companions. Corrections have landed on the local `main` and were not yet pushed at the time of writing, so a reader who fetches will not find them on the remote; the state described under Examples is the current working tree.

## Guidance

**A clause-(c) citation is a claim about another file. Verify it against that file before writing it, and again before accepting it in review.** Treat it the way you would treat an import path, not the way you would treat a comment. The verification is cheap and mechanical:

1. **Resolve the path.** Does the named file exist at the named location?
2. **Grep the risk-class token.** Pick the thing the mocked test says the companion covers, an error code (`SESSION_INVALIDATED`), a claim name (`reissuedAt`), a column (`sessions_invalidated_at`), a route path, and `grep -c` it in the companion. Zero means the citation is dead regardless of how plausible the filename is.
3. **Confirm it is an assertion, not a mention.** A token inside a comment or a variable name is not coverage.

**Cite by exact file path plus the token the companion asserts.** `custody-upgrade.test.ts` asserting `SESSION_INVALIDATED` is checkable. "The settings password-reset suites" is not resolvable by anyone, including the author six months later. A collective noun for a suite family is the least verifiable form and should never be used for a clause-(c) companion.

**Never write a compound citation.** "Happy-path acceptance *and* the live 401 are covered by X" fuses two claims into one sentence, and a half-true compound is precisely the shape that survives review: the reviewer spot-checks the half that holds. Split the claim, one companion per risk class.

**Prefer a two-sided link.** When the real-path file's own header declares "this file IS the clause-(c) companion for the mocked suite", both ends of the link are visible and rot together noticeably. A one-sided citation rots invisibly: the companion never learns it was named, and the citer never learns the companion changed.

**When correcting a rotted citation, re-derive the companion set from the code rather than repairing the prose in place.** Grep the risk-class token across `backend/tests/` and take the answer the tree gives. Rewriting the sentence to name a more plausible-sounding file reproduces the original defect with fresher wording.

**Audit your own correction.** A prose-fixing change is itself prose, and it introduces new claims exactly as unverified as the ones it replaces. Re-read the diff against the code once the edits are made, not once they are planned.

### The boundary against the settled dismissal

`test-mock-carve-out-clause-c-2026-05-04.md` instructs reviewers to dismiss the finding "the cited companion test does not assert the same thing the mocked test asserts" as relitigation of settled convention. That dismissal is correct and stays. It is scoped to a companion that asserts something **different**, which is by design under risk-class equivalence.

It does not reach any of these, each of which is a genuine clause-(c) gap:

- the cited file contains no assertion about the named risk class at all;
- the citation names a suite family, or any other referent that resolves to no file;
- the cited file mocks the very surface it is cited for covering.

Read without that scoping, the dismissal rule suppresses exactly this finding class, and a reviewer or a review persona can wave through the next false citation by invoking settled convention. Absence is not difference. Establish that the companion covers the risk class first; only then is a disagreement about assertion shape a dismissal.

### A canary is possible, and does not exist yet

This class is mechanically checkable, which is the actionable part. The shape: scan every `.ts` under `backend/tests/`, extract each clause-(c) companion citation, resolve each named path, assert it exists, and assert its contents contain the risk-class token the mocked test names. Fail the suite otherwise. It belongs beside `backend/tests/eslint/no-stale-comment-anchors.test.ts` as a standing vitest canary, for the reason that one exists: silent rot needs a red bar, not a grep nobody remembers to run.

The honest obstacles, none of them solved today:

- **Free prose is not resolvable.** The canary needs the citation in a structured, greppable form: a `Real-path companion:` line per companion, naming an exact repo-relative path and the token it covers.

  ```
   *   (c) Real-path companion: backend/tests/routes/custody-upgrade.test.ts [SESSION_INVALIDATED]
   *       Real-path companion: backend/tests/middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts [reissuedAt]
  ```

- **The migration cost is real.** `grep -rl "carve-out" backend/tests --include=*.ts` returns 114 files, and `grep -rl "[Rr]eal-path companion" backend/tests --include=*.ts` returns 111 of them. Every one of those citations is free prose. (The commands matter: dropping the `--include` filter or matching case-insensitively returns a much larger set, so quote the command alongside the number.) A canary that only checks structured citations is worthless until the corpus is converted, and one that demands the structured form fails 111 files on the day it lands. The realistic sequencing is a diff gate first (new and edited headers must use the structured form) with the whole-tree assertion deferred, mirroring how `.githooks/pre-commit` handles the anchor classes. That precedent also sets the constraints such a gate must satisfy: near-zero false positives, an explicit diff-versus-whole-tree scoping decision, a per-line escape marker, and a mirrored self-test script under `.githooks/tests/`.
- **Docblock line-wrapping breaks naive parsing.** Cited filenames wrap mid-token across ` * ` continuation lines in this corpus. A line-based extractor silently truncates these and then reports a nonexistent file. Any parser must strip the ` * ` prefix and join continuation lines before resolving.
- **Grep the token, not the filename.** A citation audit built on searching for the cited *filename* inherits the exact blindness it is meant to remove: the filename is present, the assertion is not. The sibling lesson that a regex can match precisely at call shape and the canary still be blind applies directly. Detection granularity and assertion granularity are different axes, and only the assertion is load-bearing.
- **Token presence is necessary, not sufficient.** The check catches the rot classes actually observed. It does not catch "the companion asserts it, but weakly". That remains a review judgement under the 2026-05-04 entry.
- **The follow-up-task branch of clause (c) cannot be checked this way.** Task files archive and `tasks-archive.md` trims, so a task-slug citation is a dead pointer by construction, and per the comment-anchor convention must not appear in test source at all. Those citations should name the uncovered risk class in behavioural terms and nothing else.

Do not describe this canary as existing. It is a proposal.

## Why This Matters

**The citation is the only artifact tying a permitted mock to its justification.** When it rots, the carve-out is voided silently. The mock stays, the justification evaporates, and nothing goes red. The mocked test keeps passing, which is the whole problem: it was passing because it was mocked.

**The standing review path checks existence, not truth.** (session history) The `project-standards` persona has returned clean verdicts on carve-out compliance repeatedly, and its own wording gives the gap away: "all cited real-path companions verified to exist". Verified to exist is not verified to cover the risk class. That verdict shape recurred across separate reviews in a single week while two false citations sat in the tree. A clean carve-out verdict is therefore not evidence the citations are true, and should not be read as one.

**It is invisible to every existing guard.** The `no-stale-comment-anchors` canary and the `.githooks/pre-commit` anchor gate both match *shapes*: role-prefixed task slugs, round ordinals, `Option X.N` labels, line cites, `tasks-archive` and `see task` redirects. A prose file-name citation is well-formed under both. The line-cite arm needs a colon and a number, so a bare `recover.test.ts` never matches; the slug arm is deliberately scoped to known prefix families so legitimate hyphenated tokens do not false-trip, and a test filename is not in those families. Those guards were built for anchors that rot when *task files* archive. This rots when *test files* change, a different clock nobody is watching.

**The reviewer checklist returns a false answer.** Step 3 of the 2026-05-04 entry is the designated place where clause (c) gets adjudicated, and the fastest way to answer it is to read the header already open in front of you. That path is the one that produces the wrong answer. The checklist is sound; the input it is usually fed is not.

**The error is one-directional.** Nobody ever writes a citation that understates coverage. Every drift is toward false compliance, so the corpus accumulates unverified claims that all point the same way.

**Rot has more vectors than a rename.** The observed ones: the named file exists and is large and plausible but never contained the assertion; a suite family is named collectively and no member of it ever asserted the code; the named file mocks the surface it is cited for; the behaviour moves to new sites and the citing header is not among the files the moving change touched. The last is the most common and least visible, because the change that causes the rot has no reason to open the file that rots.

## When to Apply

- **Authoring any mocked test that invokes the carve-out.** Before writing the clause-(c) sentence, grep the risk-class token and cite what the tree returns. Write the path and the token, not a description of a suite.
- **Review intake on any task whose diff adds or edits a carve-out header.** Re-run the grep yourself. Same discipline as re-enumerating a task's "covers all N (verified)" sweep claim: the header is prose, the grep is evidence.
- **Before renaming, splitting, or deleting a test file.** `grep -rn <basename> backend/tests/` first. You may be somebody's cited companion, and the citation will not follow you.
- **Before removing or weakening an assertion in a real-path test.** The assertion may be load-bearing for a mocked sibling's carve-out compliance even though nothing in the file says so. If the file declares itself a companion in its own header, that is the warning; if it does not, the grep is.
- **When sweeping any prose class across a test tree.** Enumerate by grepping the *code token* the prose is about, not by searching the prose phrasing. Prose has unbounded surface forms.

## Examples

**Rotted: the filename resolves, the assertion was never there.** `backend/tests/middleware/verifyHiveSignature-replay-revocation-hardening.test.ts` cited `recover.test.ts` as the real-path companion for the `reissuedAt` same-second revocation exemption. `backend/tests/routes/recover.test.ts` exists, is large, runs against real Postgres, and drives the real recovery flow. Every plausibility heuristic passes. `grep -c reissuedAt backend/tests/routes/recover.test.ts` returns `0`. The reissue-with-`reissuedAt` behaviour the citation named had been pinned at other sites, and the citing header was not among the files that change touched.

**Rotted: the citation does not resolve at all, and is half true.** That same file and `backend/tests/middleware/verifyHiveSignature-session-invalidation-failclosed.test.ts` both cited "the settings password-reset suites" as the live `SESSION_INVALIDATED` companion. `grep -rln SESSION_INVALIDATED backend/tests/` returns six files; none is a `settings-*` file. Six settings suites do exist under `backend/tests/routes/` (five named `settings-*`, plus `settings.test.ts`), so the referent felt real. In the fail-closed file the sentence was compound: happy-path JWT acceptance **and** the live `SESSION_INVALIDATED` 401 against real Postgres are covered by the settings password-reset suites. The first half is true, since `backend/tests/routes/settings-set-password-fresh-auth.test.ts` mints real Bearer JWTs against real Postgres with `verifyHiveSignature` explicitly not mocked. The second half is false. A reviewer spot-checking the half that holds concludes the sentence holds. The correction kept the true half attached to its true referent and redirected the false half.

**The correct companion had announced itself.** `backend/tests/middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts` opens by declaring itself the carve-out clause-(c) real-path companion that pins the actual round-trip. It drives a genuine reissue through `POST /api/auth/recover/verify`, reads `sessions_invalidated_at` back from Postgres, asserts the decoded token's `reissuedAt` equals that epoch-ms, and asserts a control token minted in the same integer second without the claim is rejected with `SESSION_INVALIDATED`. It even documents which regression it catches deterministically and which only probabilistically, and warns against relying on it for the latter. The companion knew what it was. Two other files pointed elsewhere. The one-sided link is the defect.

**Current state.** Both mocked headers now name `verifyHiveSignature-reissuedat-roundtrip.test.ts`, `verifyHiveSignature-reissuedat-orcid-roundtrip.test.ts`, and `custody-upgrade.test.ts` for the `SESSION_INVALIDATED` and `reissuedAt` risk classes. Each stamps a real epoch against real Postgres and then presents a pre-rotation bearer token to the real middleware. One un-greppable pointer deliberately survives in the fail-closed header, where happy-path JWT acceptance is still attributed to the settings password-reset suites as a category: the claim is true, and no single file is the obvious referent. It is a standing example of the shape this entry argues against, and a concrete unit of the 111-file migration.

### Method note: one sweep pass is not enough for a prose class

The rotted citations surfaced only because the sweep was run more than once, by different means. Supporting method, not the headline, but it is why the class was found at all:

- A seven-lens sweep searched for `password reset` and not the hyphenated `pre-reset`, so it never reached `backend/tests/routes/ipfs-upload-token-revocation-epoch.test.ts`. An independent manual re-enumeration caught the omission.
- A second five-lens audit, run over the fix's own diff rather than over the original target set, reached `verifyHiveSignature-session-invalidation-failclosed.test.ts`, a file neither earlier pass had touched, and where a third false citation lived. That audit also caught that the first pass had edited the very line carrying the settings-suite citation in the hardening file and corrected only the half it was looking at, leaving the other half standing. Editing a line is not the same as reading it.
- That same audit caught two inaccuracies the fix had itself introduced: an over-widening that named the custody upgrade in a suite that cannot reach it, and a companion list that read "the reissue sites" while naming two of three.

The transferable part: search the code token, not the prose. `SESSION_INVALIDATED` and `reissuedAt` have one spelling each; "password reset" has at least three, and the one you do not think of is where the miss lives.

## Related

- Root `CLAUDE.md` "Carve-out for deterministic edge-case coverage" is the canonical clause (a)/(b)/(c) text this entry guards.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` is the definitional ancestor. It settles what clause (c) means and owns the reviewer checklist. This entry adds the precondition upstream of that test, and scopes its dismissal rule: "does not assert the same thing" covers a companion that asserts something different, not one that asserts nothing, names no resolvable file, or mocks the surface it is cited for.
- `agents/docs/solutions/conventions/coverage-claim-downgrade-requires-codebase-search-2026-05-21.md` is the prior instance of this exact falsehood, where a header named a companion that mocked the same surface. It prescribes a manual search at the downgrade moment. This entry is the recurrence: that procedure was in force and two further false citations landed anyway, which is the argument for a resolver rather than more discipline.
- `agents/docs/solutions/conventions/comment-anchor-rot-precommit-diff-gate-2026-06-14.md` is the precedent for turning a prose-hygiene convention into a mechanical gate, and the source of the constraints the proposed canary must satisfy. Note the shape difference: that gate is a regex over added lines, while a companion-citation canary must resolve a path and then grep the target file.
- `agents/docs/solutions/conventions/universal-mock-inventory-must-be-re-derived-not-incrementally-patched-2026-06-11.md` is the clause-(a) sibling of this defect. Both are unverified prose inside the same header, and both are cured by re-deriving the claim from ground truth. A header can be false in its mock inventory and in its companion citation independently; audit both.
- `agents/docs/solutions/conventions/real-path-companion-dismissal-criteria-2026-05-11.md` governs the other branch of clause (c), where a reasoned dismissal stands in for a companion. A dismissal reasoned against a companion that does not cover the named risk class is unsound, so confirming the citation is a precondition for applying those criteria.
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` is the general comment-rot rule. This entry is the special case where the rotting comment is load-bearing for a convention rather than merely informative.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` states the outcome at stake: a mocked test whose companion citation is dead has no integrated-path mutation coverage at all.

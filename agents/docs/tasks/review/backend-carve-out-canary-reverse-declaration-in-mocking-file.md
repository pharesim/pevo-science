# Two mocked suites can discharge each other's clause (c) through the reverse citation form

**Owner:** backend
**Created:** 2026-10-01

## Why

The carve-out companion-citation canary
(`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`)
accepts a reverse declaration, `Real-path companion for: <path>`, as the
structured citation that satisfies a block's label. The header justifies
exempting that form from a risk-class token: "A reverse declaration discharges
no clause of its own: the file writing it mocks nothing, so it is a signpost
rather than a justification". The canary never checks that premise.

Reproduced on 2026-10-01 against an isolated copy of HEAD, by planting two
files under `tests/routes/`. Both carry `vi.mock` of the pool module, so
neither runs a real path:

- File A's clause-(c) line is a reverse declaration naming B. A also spells a
  unique token in code, outside any mocking call.
- File B's clause-(c) line is a forward citation of A with that token.

The canary stays green at 11 of 11. The control, B citing a token A does not
contain, goes red naming the planted citation, so the planted files were
scanned. A's carve-out obligation is discharged by a signpost, and B's by a
file that mocks the same surface. That is the shape the clause-(c) convention
exists to stop, and nothing goes red.

The header's "What that link does NOT establish" paragraph discloses a weaker
case: two files citing each other while neither mocks anything. It does not
cover a mocking suite discharging its own clause (c) through the reverse form.

The previous implementation round recorded the obvious fix as too blunt:
"a reverse citation in a file containing any mocking call does not satisfy a
label". `vi.fn` and `vi.spyOn` are in `MOCK_CALL_RE` and occur in nearly
every suite, including real-path companions.

## Scope

1. Decide how the canary recognises a file that owes clause (c) itself, and
   refuse the reverse form as the discharge of that file's own clause-(c)
   label. Candidate directions, to be measured against the corpus before
   choosing:
   - Key on the block. A reverse declaration does not count toward the label
     of a block that is its file's own carve-out statement, identified by
     clause (a) and (b) markers or the carve-out wording beside it. A
     real-path suite then writes its self-declaration outside any carve-out
     block of its own.
   - Key on module replacement. Count only the calls that replace a module
     (`vi.mock`, `vi.doMock`) rather than every member of `MOCK_CALL_RE`.
     Measure how many genuine real-path companions also replace an unrelated
     module (logger, mailer), since each of those becomes a false accusation.

   If the corpus measurement shows the choice needs architect input, move
   this task to `blocked/` with a `[BLOCKED by Architect]` note stating the
   measured options instead of guessing.
2. Before choosing, check whether any structured reverse citation exists in
   the corpus today. The 2026-09-06 implementation round found none, so a
   change then migrated nothing. Re-measure rather than rely on that.
3. Update the header's reverse-form paragraphs and the "What that link does
   NOT establish" paragraph to state what the check now establishes and what
   stays a review judgement.

## Acceptance criteria

1. The planted pair described above fails the canary, pinned by a probe that
   drives `auditSources` or `citationViolations` with synthetic sources.
2. A real-path suite that declares itself the companion through the reverse
   form, answered by a mocked suite's forward citation, still passes. The
   existing reverse-form probes stay green.
3. The new arm has a probe that goes red when the arm alone is neutered.
4. Every header and docblock sentence about the reverse form describes
   measured behaviour.
5. The canary is green. `LANDING_FREE_PROSE`, `LANDING_FILELESS`, both
   deferred maps and `LANDING_DIGEST` are untouched.

## Notes

This task and two sibling tasks edit the same canary file:
`backend-carve-out-canary-mixed-script-confusable-set` and
`backend-carve-out-canary-loose-claim-accuses-docblock-example`. Land them one
at a time. Anchor any comment you write on stable symbols, never on line
numbers, task slugs or round numbers.

Plant files only in an isolated probe copy, never in the shared checkout. Use
the backend probe recipe: `git archive HEAD backend`, symlinked
`node_modules` and `.env`, and `tests/setup.ts` replaced by `export {};`.

## Backend implementation signal (2026-10-01, commit 65a86fc4)

Decision: key on the BLOCK. Two designs were measured on isolated copies;
two judges both chose the block key.

Scope 2, re-measured: `citationsIn` over every comment block finds exactly
one structured reverse citation, the canary's own self-excluded header
example. Five files write prose "Real-path companion for the ...", none of
which parses as the reverse form. Nothing migrates.

Why not module replacement: all 4 live forward-cited companions
(`verifyHiveSignature-authmethod`, `-reissuedat-roundtrip`,
`-reissuedat-orcid-roundtrip`, `custody-upgrade`) call `vi.mock` (on
`hive.js`, `redis.js` or `app-db.js`) and carry their own (a)/(b) header;
`admin-fresh-auth-real-path-verifyhivesignature` mocks `app-db.js` like
the planted attacker. Module keying accused 5 of 5 and no narrowing (pool
modules only) separated them from the plant.

Landed in `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`:
- `OWN_CARVE_OUT_RE` / `statesOwnCarveOut`: clause-(a)/(b) marker in every
  corpus spelling (`(a)`, `clause (a)`, `clause-(a)`, `clause a)`,
  `clause-a`), rejoined view, not a call like `fn(b)`. Carve-out wording is
  deliberately not read (124 of 127 labelled blocks use it, and an honest
  self-declaration does too).
- `validationViolations` pushes `REVERSE_IN_OWN_CARVE_OUT` for a reverse
  citation in such a block; the message names both ways through.
- Header: drops the premise "the file writing it mocks nothing", states the
  block arm, records module keying as measured and declined, says the marker
  test is a heuristic, and "What that link does NOT establish" lists the
  residual review judgements (no marker, a comment of its own, `vi.spyOn`
  of the risk-class function), the no-marker case pinned by `bareA`.

AC 1: synthetic pair-a/pair-b through `auditSources` + `validationViolations`
yields exactly one violation, on pair-a's block, while `citationViolations`
is clean per citation. On disk (designer's copy): planted escape green at
base, red under the arm; absent-token control red both times.
AC 2: honest pairing (self-declaration in a comment separated by code)
clean; every existing reverse probe green. The cost is pinned: the same
declaration inside its own (a)/(b) header goes red (`inHeader`).
AC 3: neuters re-run on an isolated copy of the integrated file:
`statesOwnCarveOut` forced false, red (1 failed); push guarded by `false &&`,
red (1 failed); `kind === 'reverse'` guard dropped, red (2 failed, incl. the
whole-tree validation spec); unmodified, 12/12 exit 0.
AC 5: canary green 12/12 exit 0, `typecheck:tests` clean; `LANDING_*`,
deferred maps and `LANDING_DIGEST` untouched.

Cost for architect to accept: a real-path suite that takes a carve-out of
its own must write a reverse self-declaration outside that header block,
separated by code (a blank line alone does not split blocks).

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed `65a86fc4` via `/ce-code-review` (focused: orchestrator correctness, standards and
requirements read plus one independent in-process adversarial read). Verified on an isolated
copy of `65a86fc4`: canary 12/12, exit 0. Your three neuters reproduce exactly. The corpus
counts in your signal hold: one structured reverse citation (the canary's self-excluded header
example), 127 labelled blocks, 124 with carve-out wording, and the 4 forward-cited companions
all call `vi.mock` and carry an (a)/(b) header. AC 1, 2, 3 and 5 are met. The block key and its
cost are accepted (user, 2026-10-05), with the cost stated as measured in item 1. Two items
remain under AC 4, both in `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`.

1. **The header's cost and the failure message describe a narrower reach than the arm has.**
   `statesOwnCarveOut` fires on any block carrying a clause-(a) or clause-(b) marker. Measured in
   review: the four suites whose header declares the file itself the real-path companion in
   prose (`hafsql-btrim-charset-real-postgres.test.ts`,
   `wot-vouch-status-select-real-postgres.test.ts`,
   `middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts`,
   `routes/admin-fresh-auth-real-path-verifyhivesignature.test.ts`) all write that declaration in
   a block where `statesOwnCarveOut` is true. Two of them, the hafsql-btrim and wot-vouch suites,
   contain no `vi.mock`, `vi.doMock` or `vi.spyOn` call, and both are entries in
   `DEFERRED_FREE_PROSE`, which the header tells authors to convert. Converted in place to the
   reverse form, either goes red, and the message says its block "states this file's own
   carve-out". Meanwhile the header confines the cost to "A real-path suite that also takes a
   carve-out of its own". The module-key paragraph ("so that key refused the reverse form in the
   very suites it exists for") is true of the module key. But in context it reads as if the
   block key refuses fewer. In place it refuses all four self-declarations, including the two in
   files the module key would admit. What it adds over the module key is the way through by
   placement.
   Fix: in `REVERSE_IN_OWN_CARVE_OUT` and in the header's WHAT IS CHECKED sentence about
   `statesOwnCarveOut`, say the block carries a clause-(a) or clause-(b) marker, not that it
   states the file's own carve-out. Word the move advice as separation from that (a)/(b) list by
   code. In the header's reverse-form paragraph, state the cost as measured: a suite whose
   header lists (a)/(b) clauses writes its reverse self-declaration in a comment separated from
   that list by code. Today that is every self-declaring suite, including two that mock
   nothing. Also state that this placement way through is what the block key gains over the
   module key. Arm behaviour stays as it is.

2. **`OWN_CARVE_OUT_RE` misses two marker spellings the corpus writes.** Its docblock says it
   reads a marker "in every spelling the corpus writes one", and the marker probe's comment says
   the same. The corpus also writes "clauses a/b/c" (`ipfs-cleanup-backend-dispatch.test.ts`,
   `routes/auth-log-shape.test.ts`, twice in `routes/accreditation.test.ts`) and "clauses (a/b)"
   (`routes/auth-smtp-transporter.test.ts`). The pattern reads neither, because `\bclause[\s-]*`
   stops at the `s` and `(a/b)` is not `\([ab]\)`. No block is missed today, since each of those
   blocks also carries a separate (a) or (b) item. Measured in review: a pool-mocking suite that
   writes only the house spelling, with a reverse declaration as its clause (c), answered by a
   forward citation, stays green.
   Fix: accept the plural (`clauses?`), and add `'per root CLAUDE.md test carve-out, clauses a/b/c'`
   and `'carve-out clauses (a/b)'` to the positive marker list. Checked in review with node:
   every existing negative probe string, and `clauses are`, stays false under `clauses?`. If you
   take a different form, the bar is the same: every marker spelling the corpus writes matches,
   and the docblock's claim is true.

Dismissed (user, 2026-10-05): the wrapped-marker probe input `'per clause-\n(a)'` is matched by
the bare `(a)` alternative, so `rejoined` inside `statesOwnCarveOut` is unpinned (replacing it
with the raw text stays green). No failure follows from it.

No action, already disclosed by the header and measured in review: the same mutual discharge
through two forward citations; a reverse declaration relocated into a comment of its own; a
carve-out listed without (a)/(b) markers.

Keep AC 5 as it stands. Anchor any new comment on stable symbols only. The mixed-script task is
also held on this file; land the two one at a time.

## Backend re-review signal (2026-10-05, commits 05573a43 and 0e120d20)

Both commits are on main (`git merge-base --is-ancestor`, checked). The arm's
behaviour is unchanged. 0e120d20 fixes what a four-lens adversarial
verification of 05573a43 found (neuters, marker census, prose truth, in-place
plants).

Item 1, reach and cost wording:
- `REVERSE_IN_OWN_CARVE_OUT`, the WHAT IS CHECKED sentence, the
  `statesOwnCarveOut` and `validationViolations` docblocks and the probe
  comments now say the block carries a clause-(a) or clause-(b) marker.
- Deviation from the hold's literal wording. The move advice reads
  "separated from the marker by code", not "from that (a)/(b) list".
  Measured: `routes/app-ssr-discipline-real-path.test.ts` declares itself in
  a header whose only marker is the single mention `clause (b)`. There is no
  list there to separate from. The header says the arm fires on a list or a
  single mention.
- Deviation from the hold's census. "Every self-declaring suite, including
  two that mock nothing" measures false. 13 suites declare themselves, in a
  comment, the real-path companion of another named suite:
  - 9 declare in a block with a marker: hafsql-btrim-charset-real-postgres,
    wot-vouch-status-select-real-postgres, app-ssr-discipline-real-path,
    verifyHiveSignature-authmethod, -reissuedat-roundtrip,
    -reissuedat-orcid-roundtrip, admin-fresh-auth-real-path-verifyhivesignature,
    ipfs-upload-real-path-verifyhivesignature and
    papers-retract-real-path-verifyhivesignature. The first three call no
    `vi.mock`, `vi.doMock` or `vi.spyOn` in code.
  - 4 declare in a block with no marker: the reviews-real-haf,
    consent-ops-real-haf and lib/idempotency-real-haf headers (each takes no
    carve-out and mocks nothing), and the comment above the
    refundStatusCodes Redis-path spec in middleware/rateLimit.test.ts.

  The header states this without counts. "Most" declare inside a
  marker-carrying header, among them suites that mock nothing, and each of
  those goes red converted in place. For the rest, "this arm lets them
  convert in place". That sentence is scoped to the arm on purpose:
  reviews-real-haf converted in place stays silent on the arm but trips the
  leaky-prose check on its sibling-coverage list.
- The placement gain over the module key is stated. A new `noMock` probe
  pins the cost for a suite that mocks nothing. A mutant that ANDs the arm
  with the module key goes red only through it.
- Found in verification, now recorded in the header and the docblock and
  pinned: the word form reads an article `a` after a dash or an open paren
  as clause (a). Corpus instances are "clause — a bridge account" in
  reputation-active-authors-accredited-filter-canary and "clause (a `from`"
  in no-session-proof-mint-outside-reauth-routes. The singular form predates
  this round; item 2's plural extends it. There is no verdict effect, since
  the corpus holds no reverse citation.

Item 2, marker spellings:
- `OWN_CARVE_OUT_RE` is now
  `/(?<![\w)])\([ab](?:\/[a-c])*\)|\bclauses?[\s-]*\(?[ab]\b/i`. It takes the
  plural as held, plus the slash list `(a/b/c)`, which
  `signup-verify-resume-argon-error-translation.test.ts` writes alone in its
  header.
- Positive probes: the hold's two strings, plus `(a/b/c)`, `clauses a/c` and
  a bare `clause a + clause c`. `clauses a/c` is the one plural spelling that
  changes a block today: the comment above the notifications edit/revote
  dedup canaries. The bare form is in custody-audit-retention-sweep. The
  docblock lists all of them. One negative was added: 'clauses are read'.
- Corpus: 207 blocks carry a marker, 205 at the parent. The two blocks that
  flip are that notifications comment and the signup-verify-resume header.
  Neither holds a reverse citation, so no verdict changes.

AC 3 neuters, each run alone on an isolated copy:
- Of 05573a43, each of these goes red: plural dropped; slash list dropped;
  `statesOwnCarveOut` forced false; message reverted; push guarded by
  `false &&`; lookbehind removed; arm ANDed with the module key (red via
  `noMock` only).
- Of 0e120d20, the move advice reverted goes red.

AC 5: canary 12/12, exit 0, at 0e120d20. `typecheck:tests` is clean.
`LANDING_*`, the deferred maps and `LANDING_DIGEST` are untouched.

Considered and not done:
- Renaming `statesOwnCarveOut`, `OWN_CARVE_OUT_RE` and
  `REVERSE_IN_OWN_CARVE_OUT` to marker names. The hold names them, and the
  docblock now says the marker stands in for a carve-out statement.
- Tightening the regex to drop the article over-read. A measured candidate
  drops only the two article blocks, but arm behaviour was to stay as it is,
  so the over-read is documented instead.
- Pinning the slash list's `[a-c]` bound and the `)` member of the
  lookbehind. Both failure modes are theoretical, and the second predates
  this task.

For triage, outside this task:
`wot-vouch-status-select-real-postgres.test.ts` clause (c), and a comment in
`routes/wot-vouch-broadcast-outcomes.test.ts`, name
`tests/routes/wot-retract-cascaderevocation.test.ts`. That file was deleted
in 11039c47. The citation is unchecked free prose in a `DEFERRED_FREE_PROSE`
block.

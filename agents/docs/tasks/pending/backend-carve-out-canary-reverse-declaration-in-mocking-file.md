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

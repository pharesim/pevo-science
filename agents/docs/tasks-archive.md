## Pin the custody-derivation canary's unpinned surfaces (archived 2026-10-05) — two review rounds; four scope items landed with a 43-mutant record; four prose hold items fixed; one confirmed P3 and three implementer triage items filed as backend-custody-canary-docblocks-overclaim-coverage

### Architect archive note (2026-10-05)

Re-review of ab6fe37b with /ce-code-review (full: correctness, in-process adversarial, testing,
maintainability, project-standards, learnings, one validator). Hold items 1 to 4 (the 2026-10-01
hold and the 2026-10-05 addendum) are all met, and the user-approved deletions and narrowings
are true at ab6fe37b. Orchestrator run on a git-archive copy of ab6fe37b: tests/eslint/ 9 files,
146 tests, exit 0. One confirmed P3: the STATEMENT_JOIN_CAP docblock ("steps over comment lines
for free", "stepping over prose costs nothing there") and one probe comment still claim every
comment line is free, while statementFrom joins a line isCommentLine reads as live, such as an
unstarred line inside a block comment.

Triage (user: "as recommended"):
- Filed backend-custody-canary-docblocks-overclaim-coverage (low): the P3, plus three items from
  the implementer's "for architect triage" list: the typed destructure against "absolute" and
  "every spelling", parenthesised and cast ternary branches against the two ternary descriptions
  (prose only), and the walk-cap "twelve or more consecutive comment lines" sentence.
- Dismissed: the EPOCH_TERNARY_RE pattern change (no instance in backend/src); the scan-2
  over-matches (safe direction, the listed examples unseen as written); the adversarial note that
  the signal's "a derivation REPLACING a helper call is red in scan 1" fails at POST /recover (the
  code text is true there, only the signal's rationale was wrong); the "four row-reading mints"
  count (true at HEAD, and the hold prescribed it).
- Compound: no (a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each.md covers it).

**Owner:** backend
**Created:** 2026-09-08
**Priority:** low

Routed out of the round-5 architect review of
`backend-custody-column-self-alignment`. All four items are pre-existing, on
surfaces that task's diff never touched. Filed separately rather than held so
a task otherwise finished after two small fixes does not grow two more rounds.

## Why

`backend/tests/eslint/no-custody-claim-derivation-outside-helper.test.ts` is a
merge-blocking guard: it scans `backend/src` and refuses a second derivation of
the JWT `custody` claim outside `custodyClaimFor`, and refuses a row-reading
mint that does not use it. Its failure mode is not a crash. It is going green
while the guard is dead.

Four of its surfaces are currently unpinned, each verified by execution during
the round-5 review rather than reasoned about:

1. `JWT_MINT_RE` is referenced exactly twice, at its definition and at the mint
   scan. Every other scanner in the file carries planted positives and
   negatives, and the sibling canary
   `no-session-proof-mint-outside-reauth-routes.test.ts` pins its identical
   copy of this same pattern with three probes. Mangle `JWT_MINT_RE` here and
   the scan finds no mints at all, which every emptiness assertion in the mint
   test satisfies.
2. `ALLOWED_LITERAL_CLAIM_SITES` and `ALLOWED_CLAIM_CARRY_SITES` are read only
   through `.includes`. `ALLOWED_HELPER_CALL_SITES` in the same file gets a
   set-equality assertion against the observed sites. The asymmetry means a
   silently added entry, or an entry that has gone stale, is undetected in the
   two lists that license a claim.
3. The mint classification is a key-set membership test with no per-symbol
   tally, so a SECOND mint inside a symbol that is already licensed adds no new
   member and is never named. The file's own docblock states that a site which
   mints is refused by the claim-source classification; that is true only
   outside the allowed keys.
4. `mintPayload` walks one line past a mint whose parens open and close on the
   mint's own line: the `depth <= 0` break carries a positional term and is
   evaluated after the line has already been appended. A one-line
   `jwt.sign(...)` followed by a line carrying a custody key classifies as
   `'literal'` or `'variable'` instead of `'none'`. Unreachable today because
   all eight mint sites in `backend/src` open multi-line, and the direction is
   a false positive rather than a missed violation, so this is latent, not
   live. Nothing pins the walk's START line either: changing it to begin one
   line lower leaves the whole file green.

## Scope

1. Plant positive and negative probes for `JWT_MINT_RE`, mirroring the shape
   the sibling canary already uses for its copy. Include a non-empty assertion
   on the mint scan so "no violations" and "no mints found" stop being the same
   observation.
2. Add set-equality assertions for both claim allow-lists against the sites
   actually observed by the scan, matching how `ALLOWED_HELPER_CALL_SITES` is
   already enforced.
3. Make the mint classification a per-symbol tally rather than a membership
   test, so a second mint inside an allowed symbol is a new red bar. Correct
   the docblock sentence that states the mint-site refusal without its
   outside-the-allowed-keys qualifier.
4. Fix `mintPayload`'s overrun by replacing the positional break term with an
   explicit record that a paren was opened, and plant the two probes that
   cannot exist against the current shape: a single-line mint followed by a
   custody-carrying line, and one that pins the walk's start line.

## Acceptance criteria

1. Every scanner and every budget constant in the file is pinned by at least
   one probe that goes red when it is mutated. Demonstrate this per item by
   mutating the shipped file and recording which assertions red; a green run on
   the clean tree proves nothing.
2. The mint test can distinguish an empty violation set from an empty mint set.
3. Both claim allow-lists red on a silently added entry and on a stale one.
4. A second mint inside an already-allowed symbol is reported by name.
5. The `mintPayload` fix reproduces every existing probe result in the file,
   including both cap-boundary pairs, before it is considered done.

## Notes

- The whole-file scan and both cap-boundary pairs landed in
  `backend-custody-column-self-alignment` and are correct; do not disturb them.
  Item 4's fix in particular must leave both pairs green.
- Enumerate valid-syntax evasions before calling any item verified, and mutate
  INSIDE an allowed symbol rather than only outside one. A guard that is green
  on the clean tree has demonstrated nothing about what it refuses.
- Scope boundary worth stating in the file while you are there: the scan covers
  `.ts` under `backend/src` only. Content under `backend/scripts/`, other module
  extensions, and build output are outside every scan in this file, and the
  prose does not currently say so.

## Backend implementation signal (2026-09-30, commits `309f9c47`, `5f30b2b2`, `87b21065`)

All three commits touch one file,
`backend/tests/eslint/no-custody-claim-derivation-outside-helper.test.ts`, and
each is an ancestor of `main` (`git merge-base --is-ancestor` checked).
`npx vitest run tests/eslint/` at `87b21065`: 9 files, 141 tests, exit 0.
`npm run typecheck` and eslint on the file clean. The file holds 8 `it` blocks.

**What landed, per scope item**

1. `JWT_MINT_RE` is read through one helper, `mintColumns`, which both the scan
   and the spelling probes use, so the probes pin what the scan matches with,
   flags included. Planted positives and negatives, every unseen spelling the
   docblock names, and a non-empty assertion on the tree scan.
2. The literal and carry lists are compared by tally against the mints the scan
   observed. Added, stale and duplicated entries are each red.
3. The scan returns a list (one entry per match, so two mints on one line are
   two), and each licence list is a tally expectation: one entry, one mint. The
   helper callers that mint got a list of their own, `ROW_READING_MINT_SITES`,
   because calling the helper is not a licence to mint: the two settings
   handlers call it and issue no session. A second mint inside any licensed
   symbol shows in the failure diff as `"<file>#<symbol>": 2`. The docblock
   sentence on the mint-site refusal carries its qualifier.
4. `mintPayload` counts parens from the mint's own column and ends on the line
   where the count returns to zero after a paren was opened. Probes: a one-line
   mint followed by a custody-carrying line in both spellings, the walk's start
   line in both directions, a paren closed ahead of the mint, a second opener
   after the close, and the end of walk plus both cap-boundary values on the
   column path the tree scan takes.

Scope boundary (`.ts` under `backend/src` only) is stated in the top docblock.

**Deviation from the literal scope, flagged:** item 3 asked for a tally; it did
not ask for a new list. `ROW_READING_MINT_SITES` is one. Without it the
helper-caller half of the second-mint refusal had to live inline in the tree
test, where the first mutation pass disabled it with the file green.

**Acceptance criterion 1: mutation record at `87b21065`**

Run in a scratch copy built with `git archive`, `tests/setup.ts` stubbed, one
mutation at a time, byte-exact restore confirmed with `cmp`. 43 of 43 red, no
parse errors. Summary by item (mutation: what went red):

- Item 1. Pattern matches nothing: the tree non-empty assertion, the planted
  scan and the cap pair through the scan. Drop `\b`, drop `\s*`, admit
  `jsonwebtoken`, admit `sign\w*`, admit whitespace round the dot, lookbehind
  for `\b`: one spelling probe each. `mintColumns` with `gi`, with a hardcoded
  narrowed pattern, returning the first match only: red. Scan confined to
  `routes/`, scan without the block-comment region, scan without the comment
  skip: red.
- Item 2. Literal list entry added, removed, duplicated; carry list entry
  added, emptied, duplicated; row-reading list entry removed, settings handler
  added: red at the matching tree tally assertion each time.
- Item 3. `tally` always 1, saturating at 2; `keysOf` deduping; caller test by
  prefix; literal or claimless bucket dropping helper callers; partition
  swapped; symbol resolved one line up; site label off by one; classifier
  precedence swapped: red.
- Item 4. The old break shape; the `opened` flag dropped; counting from column
  0; the column applied to every line; the column ignored; start one line
  lower; start one line higher; cap bound `<`; no cap on the column path; cap
  one short on the column path; `STATEMENT_SCAN_CAP` at 11 and at 13: red.

Tree-side (canary untouched, `backend/src` mutated): a second literal, variable
or claimless mint inside `POST /upgrade`, `POST /login`, `POST /session` and
`POST /recover/verify`, after the first, on its line and on its closing line;
a first mint in either settings handler; a removed mint at a row-reading,
carry or literal site; a new handler minting each kind; a one-line claimless
mint followed by a custody line: all red, offending symbol named.

**Acceptance criteria 2 to 5:** 2 met twice (the non-empty assertion, and the
tally equalities, which an empty scan also fails). 3 met, duplicates included.
4 met. 5 met: no pre-existing probe was changed or removed, and both
cap-boundary pairs are untouched and green.

**Left alone on purpose**

- `STATEMENT_JOIN_CAP` is unpinned at 1, 2, 3, 5 and 40. That is round-5 item 2
  of `backend-custody-column-self-alignment`, still pending, same file.

**For architect triage: survivors outside the four items**

Found by the mutation passes on surfaces this task did not own. Not fixed, not
filed. The first two are now stated as residuals in the scan-3 docblock; the
third is stated there too.

1. The classifier reads the text of the call's lines, not the payload object.
   Inside a licensed symbol, a mint that drops its claim stays green when a
   bare `custody` sits in the options argument, a nested object, a trailing
   comment, or as another key's value.
2. A literal licence does not check which literal. `'self'` flipped to
   `'light'` at `POST /upgrade` is green. Whether a behavioural test catches
   that flip was not checked.
3. Licence keys collide for two declarations that resolve to one name in one
   file: a second registration of the same method and path, or a nested
   function named like a licensed one, absorbs a mint moved out of the
   original.
4. Term-level survivors on older patterns: `LITERAL_CLAIM_RE` (double-quote and
   backtick styles, leading `\b`, spacing round the colon), `VARIABLE_CLAIM_RE`
   (the `\w` half of the lookbehind), `EPOCH_TERNARY_RE` (the `light`
   alternative: every positive probe has `self` first, so an inverted ternary
   is unpinned), `COLUMN_DESTRUCTURE_RE` (10 of 16 mutations green, including
   "custody must be the first member"), `COLUMN_COPY_RE` (`<>` and `$` in the
   whitelist, bracket quote styles), `BLOCK_OPENER_RE` (over-matching is
   green), `HELPER_CALL_RE` and `HELPER_DEFINITION_RE` (loosenings green).
5. `HELPER_MODULE` can be pointed at any other real module, or the exemption
   removed, with the file green: the helper's own module matches no shape
   today, so the exemption licenses nothing.
6. `statementFrom` re-inlining a literal 12 with the constant moved to 13 is
   green. The mirror mutation on `mintPayload` is red.
7. The tree test's tally assertions are sequential hard expects, so a mutation
   that breaks two buckets names only the first.

## Architect re-review (2026-10-01) — HELD PENDING FIXES:

Reviewed `6522283e..87b21065` (the three commits above, one file) with
`/ce-code-review` (correctness, adversarial, testing, maintainability,
project-standards, learnings) plus an independent validator, which confirmed
items 1 and 2. The review read the `87b21065` snapshot. HEAD has moved since:
`cca00888` and `146ce7de` (other tasks) edited this file and
`tests/support/enclosing-symbol.ts`. Make the fixes on current HEAD. The
sentences quoted below are unchanged there.

Verified and NOT held:
- Scope items 1 to 4 and the scope-boundary sentence all landed. At
  `87b21065` the file runs 8 tests, exit 0, and `tests/eslint/` runs 9 files
  and 141 tests, exit 0. The testing lens reproduced the cap, partition,
  start-line, column-path, symbol and label mutants, all eight allow-list
  add/remove/duplicate mutants and nine tree-side second-mint and claim-flip
  mutants. All of them went red. Both cap-boundary pairs are untouched.
- The `ROW_READING_MINT_SITES` deviation is accepted. The helper-caller half of
  AC4 needs it, and a non-caller entry in it reds as stale.
- The 8 `jwt.sign(` sites under `backend/src` at `87b21065` are 3 literal,
  1 carry and 4 row-reading, which matches the three lists.

AC1 is read as the four scope items, and it is met for them. Your

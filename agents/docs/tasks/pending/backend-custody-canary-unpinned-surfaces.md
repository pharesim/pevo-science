# Pin the custody-derivation canary's unpinned surfaces

**Owner:** backend
**Created:** 2026-09-08

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

# The loadWotThreshold fence canary stays green with the fence removed

**Owner:** backend
**Created:** 2026-10-07
**Priority:** low

Filed from the architect re-review of the latest-op HAF lookup task (user triage, 2026-10-07, as
recommended).

## Why

`backend/tests/wot-threshold-signer-gate.test.ts`, spec "wraps the row match in an AS
MATERIALIZED CTE and orders by the (block_num, id) tiebreaker", pins the fence with
`expect(capturedSql).toMatch(/\bAS\s+MATERIALIZED\b/i)`. The SQL literal in `loadWotThreshold`
(`backend/src/wot.ts`) carries `--` comments inside the string, and one of them reads
"(Projecting id into the CTE does not weaken the AS MATERIALIZED fence". The regex matches that
comment, so the assertion holds whether or not the CTE is fenced.

Measured at `d442a4b7` in a scratch copy, by the adversarial reviewer and again by the architect:

- `WITH candidates AS MATERIALIZED (` replaced by `WITH candidates AS (`, comment kept: the file
  stays green, 7 passed, exit 0.
- Same mutant with "AS MATERIALIZED" also removed from the comment: the spec fails on that
  assertion, 1 failed, exit 1.

The solutions entry `haf-custom-json-latest-op-materialized-fence-2026-06-14.md` quotes this
assertion in its Examples snippet and says the canary makes a refactor that drops the fence fail
red in CI. For `loadWotThreshold` that does not hold today.

The fence assertions in `backend/tests/hafsql.test.ts` and the reputation cycle SQL-shape specs
use `toContain('<cte name> AS MATERIALIZED (')`, which a comment of this kind does not satisfy.

## Scope

1. In that spec, anchor the fence assertion on the CTE head, e.g.
   `/\bcandidates\s+AS\s+MATERIALIZED\s*\(/i`. Leave `backend/src/wot.ts` unchanged.
2. Red first, in a scratch copy: with the fence removed from the literal and the comment kept,
   the spec fails on the new assertion. The unmutated tree passes.
3. `/ce-compound-refresh` scoped to `haf-custom-json-latest-op-materialized-fence-2026-06-14.md`:
   the Examples canary snippet quotes the assertion the spec now makes. Narrow or delete only.

## Out of scope

- The three `AS MATERIALIZED` assertions in `backend/tests/lib/idempotency.test.ts`. None of
  those three SQL literals carries such a comment today (triage: dismissed).
- Moving or rewording the `--` comments inside the `loadWotThreshold` literal.

## Acceptance criteria

1. The mutant in Scope 2 fails the spec; the unmutated file passes. Name both runs, with exit
   codes, in the signal block.
2. The entry's Examples snippet matches the spec's assertion.
3. Comments follow root `CLAUDE.md` "Comment anchors".
4. Learnings checkpoint: `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md`
   covers a comment that silences a textual match. This is the inverse case, a comment that
   satisfies a presence check. Decide whether it belongs in that entry or a new one, and record
   the outcome in the signal block.

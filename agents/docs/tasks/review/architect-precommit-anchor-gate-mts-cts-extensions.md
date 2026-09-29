# The pre-commit anchor gate's extension filter misses .mts and .cts

**Owner:** architect
**Created:** 2026-09-29

Routed out of the round-1 architect review of the canary-scan-roots task,
where `.mts`/`.cts` modules were admitted to the updated_at canary's scan
roots.

## Why

The `.githooks/pre-commit` anchor gate filters staged paths by extension
(`ts|tsx|js|jsx|mjs|cjs|sql`), which matches neither `.mts` nor `.cts`. A
future `.mts`/`.cts` module under `frontend/{src,tests}` or
`backend/{src,tests}` would land with its added lines never checked for
comment-anchor rot, because the gate is a diff gate: the introduction commit
is exactly the one it must fire on. The whole-tree
`no-stale-comment-anchors` canary shares the gap (it walks `.ts` only), but
that file is backend zone; this task covers the hook only. Moot until such a
module exists, which is why this is low priority.

## Scope

1. Widen the hook's extension filter to include `mts` and `cts`, keeping
   the existing extensions untouched.
2. Re-run `bash .githooks/tests/test-pre-commit.sh`; extend the test file
   with a `.mts` positive case if the harness shape allows one cheaply.
3. If widening the backend canary is wanted too, file that as a separate
   backend task rather than crossing zones here.

## Acceptance criteria

1. A staged `.mts` (or `.cts`) file with a violating added line fails the
   hook; the same line in a `.ts` file still fails; clean lines pass.
2. `bash .githooks/tests/test-pre-commit.sh` passes.

## Implementation signal (2026-09-29)

Landed at `86181664`. Both extension lists in `.githooks/pre-commit` now carry
`mts|cts`: the `staged_added` awk path filter (scope item 1) and the
line-cite arm of `is_rot` (same gap class, so a `loader.mts:42` cite is caught
too). Test file gains R19 (slug in `.mts`), R20 (slug in `.cts`), R21
(`.mts:NN` line cite) and A10b (clean `.mts` line accepted). Against the
previous hook R19-R21 fail (38/3); against the new hook the suite is 41
passed, 0 failed, exit 0. Scope item 3: no backend canary task filed; the
whole-tree `no-stale-comment-anchors` canary still walks `.ts` only, which
stays moot until a `.mts`/`.cts` module exists under `backend/src`.

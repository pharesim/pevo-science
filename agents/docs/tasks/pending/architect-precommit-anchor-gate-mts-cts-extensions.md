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

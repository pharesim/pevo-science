# BACKEND-CASCADE-PENDING-VOUCHEES-INCLUDE-SLICE — `cascadeRevocation` drops same-level unprocessed vouchees from `pending` when nested call throws `PartialCascadeError`

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #24 medium severity, correctness)
**Priority:** P2 (operator follow-up logs miss accounts that should be re-revoked, defeating the `PartialCascadeError` surface's whole purpose)

## Problem

[wot.ts:382-397](backend/src/wot.ts#L382-L397) — when a nested `cascadeRevocation` throws `PartialCascadeError` mid-iteration, the catch folds `nested.completed` / `nested.pending` but never includes `result.rows.slice(i+1)` (current-level vouchees identified but never attempted).

The deadline-check branch at lines 313-318 correctly does `slice(i)` — the nested-error branch is asymmetric. Operator follow-up logs miss accounts that should be re-revoked, defeating the `PartialCascadeError` surface's whole purpose.

## Goal

Make the nested-error catch include the unprocessed slice symmetrically with the deadline-check branch.

### Suggested approach

Before re-throwing in the nested catch:

```typescript
for (const r of result.rows.slice(i + 1)) {
  pending.push(r.vouchee as string);
}
```

Use `i + 1` (not `i`) because the current vouchee at `i` was successfully broadcast and is already in `completed`.

## Acceptance

- Regression test: seed children for the first vouchee so the budget blows inside the nested call; assert `pending` includes the unprocessed same-level vouchees (`slice(i+1)`).
- The deadline-check branch's behavior unchanged.
- `PartialCascadeError`'s `completed` + `pending` cover all originally-identified vouchees (their union matches the seeded set).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Land BEFORE #12 (`backend-wot-cascade-single-discovery-query`) so #12's rewrite uses the correct accounting shape, OR land together as one task. The bug exists in the current loop shape; the single-discovery rewrite should preserve the correct accounting from the start.

## Cross-references

- [backend/src/wot.ts](backend/src/wot.ts) lines 382-397 (nested-error catch), lines 313-318 (deadline-check branch — the correct symmetric form).
- HAF-query review run `w274tijk0` rank #24.

## Architect re-review (2026-06-05) — HELD PENDING FIXES (2 items)

`/ce-code-review` (correctness on Opus; reliability/testing/maintainability/project-standards/kieran-typescript on Sonnet; learnings unstructured; ce-agent-native-reviewer skipped per PEvO) on commit ee33c349. The fix is verified correct for its scope: `i`/`result.rows` are in scope and stable at the catch, the new test demonstrably exercises the nested-PartialCascadeError branch (the clock jump after v1's broadcast makes the depth-1 call throw on its first deadline check) and fails RED pre-fix (pending would be `['g1']` alone), the deadline branch keeps its own independent pin, and completed ∪ pending now covers the identified set on every budget exit. tsc/eslint clean; the file's 11 tests green. The pre-existing NON-budget nested-error accounting gap was noted on the held `backend-wot-cascade-single-discovery-query` rewrite task rather than held here. Two items hold.

### Items held (must fix before archive)

1. (P2 severity, P3 practical impact; correctness + reliability) `pending` can carry duplicate account names: in a diamond-shaped graph the same vouchee can arrive via both `nestedErr.pending` and the new `slice(i + 1)` fold, and a broadcast-timeout at index j followed by a nested budget blow at k>j double-adds the rows between j and k. The consumer serializes the raw array into the operator follow-up list (re-runs are chain-idempotent, so the impact is noise, not damage). Dedupe `pending` immediately before each `throw new PartialCascadeError(...)`, switch the new test's Set-wrapped assertion to a multiplicity-sensitive sorted-array assertion, and add a diamond-graph case asserting exactly one occurrence of the shared vouchee.
2. (P3, kieran-typescript) The fix adds the third `r.vouchee as string` cast on the untyped discovery `pool.query`. Type the generic — `pool.query<{ vouchee: string }>(...)` — and drop all three casts, so a column rename becomes a compile error instead of silently pushing `undefined` into the operator list (matches the typed-generic idiom in `bridge-haf.ts`).

## Backend re-review signal (2026-06-05, commit on main)

Both 2026-06-05 hold items landed (the base `slice(i+1)` fix was already in):
1. (correctness) Deduped `pending` via order-preserving `[...new Set(pending)]` at BOTH `PartialCascadeError` throw sites (the deadline-check branch and the nested-error catch), closing the diamond-graph / timeout-then-nested double-add. Test updated: the multiplicity-blind `new Set(err.pending)` assertion is now multiplicity-sensitive, plus a new diamond-graph case (`boss → [a, d]`, `a → [d]`) asserting `d` appears exactly once (fails RED pre-dedup).
2. (typing) Typed the discovery query `pool.query<{ vouchee: string }>(...)` (mirrors `bridge-haf.ts`) and dropped the three `r.vouchee as string` casts.
The out-of-scope non-budget nested-error accounting is left untouched (it belongs to `backend-wot-cascade-single-discovery-query`). `npm run typecheck` + `npm run lint` clean.

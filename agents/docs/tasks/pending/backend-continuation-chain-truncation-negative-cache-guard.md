# BACKEND-CONTINUATION-CHAIN-TRUNCATION-NEGATIVE-CACHE-GUARD — don't cache a negative/partial chain result built from a degraded (non-abort) `resolveContinuationChain` walk

**Owner:** Backend Agent
**Created:** 2026-05-25 (architect, follow-up from `/ce-code-review` of `backend-canonical-root-walker-cumulative-aware` round-2)
**Priority:** P2

## Problem

`resolveContinuationChain` returns the chain accumulated **so far** (a partial/truncated chain) on several degraded-but-non-abort paths, NOT only on wall-clock abort:

- A transient SQL `statement_timeout` (Postgres 57014) thrown mid-forward-walk is swallowed by the walker's inner `catch`, which returns the partial chain — **without** setting `signal.aborted`.
- HAF eventual-consistency where the root's `fetchHeadAuthorizedAuthors` returns empty → a root-only chain, again with `signal.aborted === false`.
- (Lower likelihood) cycle-break / `MAX_HOPS` truncation.

`findCanonicalRoot` (the canonical-root walker) caches negative results (`{ root: null }`) for the full TTL. Its round-2 fix added a `signal?.aborted` re-check after the forward verify — but that guards **only** the abort variant. On the non-abort truncation paths above, the membership check fails for a legitimate deep-chain leaf and `{ root: null }` is cached for 30 min. The leaf then resolves to itself (broken chain/version view) until TTL expiry or `/invalidate`, even after HAF recovers within seconds.

This is **fail-closed** (it serves the leaf as a standalone post, never surfaces someone else's content), so it is an availability/correctness regression, not a security breach. It is **pre-existing** — the negative-cache-on-truncation behavior arrived with the Alternative-3 rewrite; the round-2 hold only targeted the abort sub-variant.

**Cross-cutting:** `resolveContinuationChain` is also called by `resolveChainCumulativeAuthors` (`computeChainCumulativeFromHaf`) on the cumulative-union path. There, the empty-versions guard + `reconstructVersionsFromHaf`'s abort short-circuit mitigate the abort variant, but a non-abort truncation could still feed a partial cumulative-union into the `chain-authors:` cache. The fix should be evaluated for both walkers, ideally at the shared `resolveContinuationChain` contract.

## Goal

Make truncation observable at the `resolveContinuationChain` boundary so callers can distinguish a **clean** termination (natural `rows.length === 0` end of chain) from a **degraded** one (inner-catch SQL error, empty head-authors fetch, cycle/depth truncation), and skip caching negative/partial results derived from a degraded walk.

## Design alternatives (implementer picks, surfaces for architect review)

1. **Discriminated return.** `resolveContinuationChain` returns `{ chain, terminated: 'clean' | 'degraded' }` (or a `degraded` flag). `findCanonicalRoot` caches the negative `{ root: null }` only when `terminated === 'clean'`; on `degraded`, return null without caching (caller falls back to leaf coords, recomputes next request). Apply the same gate to `computeChainCumulativeFromHaf`'s cache write.
2. **Cache-only-when-verified-complete.** Cache the canonical-root negative only when the backward walk reached a true root (no `continues`) AND the forward walk ended on a clean `rows.length === 0` break. Equivalent effect, encoded at the `findCanonicalRoot` call-site without changing the walker's return type.

## Acceptance

- A degraded `resolveContinuationChain` walk (simulate: inner-loop `pool.query` rejects with a statement-timeout-class error; and separately, empty head-authors fetch for the root) does NOT result in a cached `{ root: null }` for a legitimate deep-chain leaf. Canary asserts `canonical-root:<leaf>` is undefined after the degraded request.
- The clean negative case (a genuinely standalone non-continuation post) still caches `{ root: null }` (no regression in the legitimate negative-cache path).
- Evaluate and document whether the cumulative-union `chain-authors:` cache needs the same gate; if yes, apply it; if the existing empty-versions/abort guards already cover it, document why.
- Self-audit on added lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors.

## Out of scope

- The abort variant — already closed by the `backend-canonical-root-walker-cumulative-aware` round-2 `signal?.aborted` re-check.
- Changing the fail-CLOSED security semantics (leaf serves its own content on null) — that stays.

## Source

- `/ce-code-review` adversarial (confidence 75) during round-2 review of `backend-canonical-root-walker-cumulative-aware` (2026-05-25): constructed the SQL-statement-timeout and HAF-eventual-consistency truncation reproducers that the abort-only re-check does not cover.

## Backend completion signal (2026-05-26)

Implemented **Alternative 1 (discriminated return)** — chosen so the walker is the single source of truth for classifying its own exits; multiple negative-caching callers need the signal and a new degraded exit cannot drift per-call-site under Alternative 2's encode-at-call-site approach.

- **`resolveContinuationChain` now returns `ChainResolution { chain: ChainLink[]; degraded: boolean }`.** `degraded` starts true and flips to false ONLY at the clean natural-end break (`result.rows.length === 0`). Every other exit leaves it true: pool unavailable, pre-loop / mid-loop wall-clock abort, empty-or-failed root head-authors fetch, swallowed inner-loop SQL error (statement_timeout 57014), cycle detection, MAX_HOPS truncation.
- **`findCanonicalRoot` (STEP 4) gates the negative cache.** A membership-failed `{ root: null }` is written only when `resolved !== null || !forwardDegraded` — positives always cache, and a negative caches only when the forward verify walk was clean. A degraded forward walk that drops a legitimate deep-chain leaf now skips the write (emits `canonical_root_walker_degraded_negative_uncached` at debug) so the next request re-resolves after HAF recovers. The abort variant stays handled by the existing `signal?.aborted` re-check; this closes the non-abort degraded gap.
- **`computeChainCumulativeFromHaf` (the `chain-authors:` cache) gets the same gate — YES, it needed it.** `if (degraded) return null` after resolving the chain, so a partial chain's under-populated cumulative author-union is never cached (the surrounding `getOrSet` drops null). This subsumes the abort variant (previously covered only by the empty-versions guard) and closes the mid-walk non-abort truncation gap for chains longer than the root; the `chain.length === 1` short-circuit already covered root-only degraded walks.
- **Live surfaces don't gate.** `fetchPaperDetailFromHaf` and `reconstructVersionsFromHaf` destructure `.chain` only — a degraded (partial) walk shows fewer versions (existing fail-soft behavior) and is not negative-cached.

Canaries in `tests/routes/papers-canonical-root-walker.test.ts`: (1) forward-walk SQL statement-timeout (57014, non-abort) → `canonical-root:carol:v3` stays undefined; (2) empty root head-authors fetch (HAF eventual consistency) → same; (3) clean negative (leaf genuinely outside a fully-walked chain) STILL caches `{ root: null }` (no regression). The existing mid-step-2 abort cache-skip canary stays.

**Verification.** `npm run typecheck` clean (src + tests); `npm run lint` (src) clean on `routes/papers.ts` (the one remaining warning is pre-existing in `author-supersession.ts`, untouched); scoped `npx vitest run` → walker 9/9, plus cumulative-cross-surface + route-error-isolation + continuation-author-gate 59/59 (covers the `chain-authors:` and per-row enrichment paths). Self-audit on changed lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors in the source/test files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

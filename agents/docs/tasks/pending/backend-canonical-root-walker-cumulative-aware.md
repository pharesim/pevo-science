# BACKEND-CANONICAL-ROOT-WALKER-CUMULATIVE-AWARE — make findCanonicalRoot cumulative-aware

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, follow-up to `backend-multi-author-cumulative-union.md` round-1 review)
**Priority:** P2

## Problem

`backend-multi-author-cumulative-union` (commit b22ce5d) rewrote the **forward** chain walker (`resolveContinuationChain`) for per-hop cumulative admit-set. The **backward** chain walker (`findCanonicalRoot` at `backend/src/routes/papers.ts:1682`) was deliberately left unchanged, per the architect's re-review note ("strictly stricter than cumulative-union's per-hop check, therefore fail-CLOSED").

Round-1 adversarial review (adv-002 P2/90) corroborated correctness #1 (P2/100): the backward walker's stricter per-hop check ("child author in immediate predecessor's `pevo.authors[]`") causes a real **cache-data inconsistency** beyond the documented UX edge case.

Reproducer: chain `alice/p1 → bob/v2 → carol/v3` where bob/v2's `pevo.authors[]` drops alice. Forward walker admits carol's hop (cumulative set includes alice + bob from earlier hops). Backward walker from `carol/v3`: per-hop check rejects carol → bob → alice because bob's `pevo.authors[]` doesn't list alice. Backward walker stops at `bob/v2` (or earlier), declaring that the canonical root.

Effect:

- Hit URL `/api/papers/alice/p1` → canonical = `alice/p1` → cache key `paper-detail:alice:p1` → response with cumulative authors `[alice, bob, carol]`, full citation count, complete versions[].
- Hit URL `/api/papers/carol/v3` → canonical = `carol/v3` (or `bob/v2`) → cache key `paper-detail:carol:v3` → response with different cumulative (starting from a non-root), different `accredited_authors`, different `citation_count`, different `versions[]`.

Two cached views of the same chain, served depending on entry URL. 30-min stable cache TTL means divergence persists. Citation counts diverging means downstream reputation potentially sees one chain as two papers.

The architect re-review note explicitly anticipated this filing with the same slug: "If this UX edge case needs closure, file `backend-canonical-root-walker-cumulative-aware.md` as a follow-up."

## Goal

Make `findCanonicalRoot` cumulative-aware so the backward walker resolves to the same canonical root as the forward walker would admit, regardless of URL entry point. Eliminate the cache-data inconsistency.

## Design alternatives

Implementer picks and surfaces for architect review before implementation:

1. **Build cumulative on backward walk.** Each backward hop fetches the predecessor's `pevo.authors[]`, builds the cumulative incrementally going backward, and admits the child if it's in any predecessor's contribution to the cumulative. Symmetric with the forward walker's per-hop cumulative admit-set.

2. **Recursive CTE for chain resolution.** Resolve the canonical root in a single SQL round-trip via a recursive CTE that walks both directions and computes the cumulative.

3. **Forward-walker delegation.** Backward walker resolves to the immediate predecessor only; canonical-root resolution is then a forward walk from that predecessor to find the chain root. Two-phase but mechanically simpler.

## Acceptance

- For the reproducer chain (alice/p1 → bob/v2 with bob dropping alice → carol/v3), `findCanonicalRoot('carol', 'v3')` resolves to `alice/p1`. Canary asserting the resolution.
- Cache keys for the same chain are consistent across entry URLs.
- `citation_count` and `accredited_authors` are identical across the two URL entries.
- The backward walker's security property (fail-CLOSED: attacker can't surface someone else's content under their URL) is preserved.

## Out of scope

- Forward walker — already correct per b22ce5d.
- Listing surfaces — separate task `backend-cumulative-union-listing-surfaces-parity.md`.

## Source

- `backend-multi-author-cumulative-union` round-1 `/ce-code-review` correctness #1 (P2/100) + adversarial adv-002 (P2/90) cross-corroborated.
- Architect re-review note in cumulative-union task body anticipated this filing with the same slug.

## Cross-references

- `agents/docs/tasks/pending/backend-multi-author-cumulative-union.md` — sibling task; forward-walker closure at b22ce5d.
- `backend/src/routes/papers.ts:1682` — findCanonicalRoot site.

---

## Backend design proposal (2026-05-16) — awaiting architect ratification

### Recommendation: Alternative 3 — forward-walker delegation, leveraging the shared chain-resolver helper from `backend-cumulative-union-listing-surfaces-parity`

**Shape:**

1. **Backward walk unconstrained.** Walk `pevo.continues` pointers backward from `(author, permlink)` to find a candidate root `R` (the topmost ancestor with no `continues`). No per-hop author-consent gate on this pass — purely structural.
2. **Forward verify.** Run the existing `resolveContinuationChain(R.author, R.permlink)` (the cumulative-aware forward walker landed at b22ce5d). The resulting chain is exactly the set of posts the forward walker admits.
3. **Membership check.** If `(author, permlink)` is in the resulting chain, return `R` as canonical root. If not, the leaf is outside the forward walker's cumulative admit-set (attacker-injected continuation that breaks the cumulative gate); fail-CLOSED to `(author, permlink)` itself — same shape as the current `unauthorized_hop` return at papers.ts:1833.
4. **Cache the result.** Once computed for `(author, permlink) → canonical-root`, the mapping is stable for the lifetime of the chain (continuations only extend; a leaf's canonical root never changes). Memoize in Redis under `${config.appTag}:cache:canonical-root:<leaf-author>:<leaf-permlink>` with a long TTL (24h or longer). Sibling-task `backend-cumulative-union-listing-surfaces-parity`'s per-root chain cache complements this: the forward walk in step 2 reuses warm chain-resolution entries.

### Why Alternative 3 over the other two

- **Alternative 1 (build cumulative on backward walk):** Forks the cumulative-union algorithm into two implementations (forward in `resolveContinuationChain`, backward in `findCanonicalRoot`). Any future tweak to the admit rule has to land twice or the two walkers diverge. This is the same bug class that motivated the cumulative-union rewrite at b22ce5d.
- **Alternative 2 (recursive CTE):** Adds a third implementation in SQL. Worst case for drift; recursive CTE encoding the per-hop cumulative admit-set is non-trivial.
- **Alternative 3 (recommended):** Reuses the existing forward walker by construction. Zero risk of cumulative-set divergence between forward and backward walkers. Mechanically simpler than building cumulative-on-backward.

### Cost estimate

- Worst case: backward unconstrained walk = 10 SQL queries (`CANONICAL_ROOT_MAX_HOPS`) + forward walk = up to 50 SQL queries (`MAX_HOPS` from `resolveContinuationChain`) + cumulative author build. Approximately doubles canonical-root resolution cost vs today.
- Typical case (~95% of corpus is single-link paper): backward = 1 SQL query (no continues), forward = 1 SQL query (no children). Net delta: +1 SQL query per resolution. Roughly +5-20ms.
- With the per-leaf canonical-root cache, the cold-path cost is amortized across the chain's lifetime. Detail-surface requests hit the warm cache after the first lookup per leaf.

### Security property preserved

The existing fail-CLOSED guarantee (attacker can't surface someone else's content under their URL) is preserved by step 3's membership check: if the leaf isn't reachable via the forward walker's cumulative admit-set, it's NOT admitted as a continuation, and the canonical-root resolution returns the leaf itself — same shape as the current `unauthorized_hop` fall-through.

### Files anticipated

- `backend/src/routes/papers.ts:1586-1900+` — rewrite `findCanonicalRoot` to use the two-phase approach. Drop the per-hop `fetchHeadAuthorizedAuthors` gate inside the backward walk (it's the strict per-hop check the architect identified as causing the cache-data inconsistency); replace with the unconstrained `pevo.continues` traversal + post-walk forward verification.
- `backend/src/routes/papers.ts` (new helper) — `resolveCanonicalRoot(leafAuthor, leafPermlink, …)` extracting the two-phase logic, callable from the existing detail-surface call-sites (papers.ts:2273) and any sibling consumer.
- Reuse `resolveContinuationChain` (no changes needed) — this is the load-bearing dependency.
- `backend/tests/routes/papers-canonical-root-walker.test.ts` — canary for the reproducer chain (alice/p1 → bob/v2 drops alice → carol/v3). Assert `findCanonicalRoot('carol', 'v3') === {author: 'alice', permlink: 'p1'}`. Real-HAF where feasible.

### Dependency on sibling task

This task **depends on** `backend-cumulative-union-listing-surfaces-parity`'s ratification. Both should land coherently:

- If the sibling task lands Option 4 (shared `resolveChainCumulativeAuthors` helper), this task naturally consumes that helper for step 2's forward verification.
- If the sibling task lands a different shape (recursive CTE, denormalized table), the forward verification in step 2 changes target but the two-phase shape stays the same.

Recommend the architect ratifies the sibling task's Option 4 first (or rejects it), then ratifies this task's Alternative 3 against the chosen forward-walker shape.

### Open items needing architect input

1. Confirm Alternative 3 is the right shape, given dependency on the sibling task's Option 4.
2. Confirm long-TTL cache for canonical-root resolution is acceptable (e.g., 24h, or shorter for safety).
3. Confirm the security-property analysis (fail-CLOSED on out-of-cumulative leaves) matches the architect's reading.

### Status

This task is moved to `review/` for architect ratification. No code changes have been made. Architect ratification is preferred to land jointly with `backend-cumulative-union-listing-surfaces-parity`.

[TODO Architect] Ratify Alternative 3 and clarify items 1-3 above.

---

## Architect ratification (2026-05-17)

Reviewed during the round-3 cluster review pass alongside `backend-multi-author-cumulative-union` and `backend-canonical-walker-cycle-detection`. Backend's design proposal is sound; ratified with two pins on the security analysis and one adjustment on the cache TTL.

### Ratified: Alternative 3 — forward-walker delegation

The forward-walker delegation shape is the right choice. Reasoning:

1. **No algorithm fork.** Alternative 1 (build cumulative on backward walk) reproduces the exact drift-bug class the cumulative-union rewrite at `b22ce5d` closed for the no-shrink rule — any future tweak to the cumulative admit-set rule would have to land twice or the two walkers diverge. Alternative 2 (recursive CTE) forks into a third implementation language.
2. **Cost is bounded.** Typical case (~95% single-link papers) is +1 SQL query; worst case is +60 SQL queries (10 backward + 50 forward) but amortized by the per-leaf canonical-root cache.
3. **Sibling-task synergy.** Step 2's forward verification consumes `resolveChainCumulativeAuthors` from `backend-cumulative-union-listing-surfaces-parity`'s Option 4 (which is itself ratified for the listing/profile parity surface). The shared helper is the load-bearing substrate.

### Adjusted: Cache TTL = 30 min (not 24h)

Backend's "lifetime of the chain" claim for the canonical-root mapping is almost true (continuations only extend; canonical-root cannot move BEHIND a leaf), but native Hive edits to a post's `pevo.continues` pointer within the 7-day edit window CAN change the cumulative-aware forward walker's resolution. A 24h cache would serve stale data for up to 24h after such an edit.

Use **30-minute TTL** to match the sibling task's `resolveChainCumulativeAuthors` cache. Benefits:
- Drift-window matches the rest of the chain-cumulative caching surface (no operator surprise across adjacent caches).
- Closes the edit-staleness gap at 30min vs 24h.
- Amortization difference is small: 95% single-link papers don't hit the cache either way; multi-link chains hit the cache repeatedly within a browse session.

If cache-driven staleness becomes a real complaint later, hook the canonical-root cache key into the existing `/invalidate` flow (currently invalidates paper-detail keys only) as a follow-up — don't pre-emptively land that integration.

### Confirmed: Fail-CLOSED security analysis (with 2 pins)

Backend's security argument is correct: the forward walker's per-hop cumulative gate is the authoritative admit-set; the backward walker's unconstrained traversal in step 1 doesn't admit anything; step 3's membership check enforces fail-CLOSED to the leaf when out-of-cumulative.

**Pin 1 — Lowercased-trimmed key shape on step-3 membership check.** The chain-membership check at step 3 must use the same key shape as the forward walker's admit-set: lowercased + trimmed `(author, permlink)`. A case-sensitive mismatch would inadvertently fail-OPEN against an authorized leaf with a mixed-case URL. Add a canary that pins this: leaf URL with uppercase chars (e.g., `Carol/V3`) resolves correctly when the underlying chain has lowercase entries.

**Pin 2 — Step-1 backward walker reuses the visited-Set cycle-detect primitive from `backend-canonical-walker-cycle-detection`.** The new step-1 unconstrained backward walk has the same cycle-attack surface as the existing constrained walker; reuse the same per-call `Set<string>` primitive (keyed on `${author}/${permlink}`) and emit `canonical_root_walker_cycle_detected` on cycle hit (consistent event vocabulary). The visited-Set check must be applied to both the new step-1 backward walk AND retained on the existing forward walker call in step 2 (it's already there per the cycle-detection task; just verify it isn't removed during the rewrite).

### Action

Backend may proceed with implementation per Alternative 3 + the adjustments above. The dependency on sibling task `backend-cumulative-union-listing-surfaces-parity`'s Option 4 stands; ratify and implement that sibling first (or coherently), since this task's step 2 needs the shared helper.

File `git mv`'d from `tasks/review/` to `tasks/pending/` so the backend agent picks it up at startup.

---

[BLOCKED by Architect] (2026-05-17) — Sibling helper `resolveChainCumulativeAuthors` (the load-bearing dependency for step 2 of Alternative 3) is not implemented. Sibling task `backend-cumulative-union-listing-surfaces-parity.md` is in `tasks/review/` carrying only a design proposal (Option 4); no architect ratification block has been added to that file and it has not been moved back to `tasks/pending/`. `grep -rn "resolveChainCumulativeAuthors" backend/src/` returns zero. The architect's ratification of Alternative 3 in this task body explicitly directed: "ratify and implement that sibling first (or coherently), since this task's step 2 needs the shared helper." Backend cannot start on this task without the helper.

Unblock action for architect: (a) add a ratification block to `backend-cumulative-union-listing-surfaces-parity.md` formally accepting Option 4 (or amending it), (b) `git mv` that sibling file from `tasks/review/` back to `tasks/pending/`. Once the sibling helper lands in code, move this file back to `tasks/pending/` so backend picks it up.

**Unblocked 2026-05-20 (architect).** Both gate conditions are satisfied: (a) the ratification block landed at commit `b5a0f924` ("architect(tasks): ratify Option 4 on backend-cumulative-union-listing-surfaces-parity + mv review → pending"); (b) the `resolveChainCumulativeAuthors` helper is in code at `backend/src/routes/papers.ts:619` and consumed by listing (`papers.ts:936`), profile (`profile.ts:404`), and detail (`papers.ts:1318`). Backend agent picks this up at next startup. Note: the sibling task `backend-cumulative-union-listing-surfaces-parity` is currently in `tasks/review/` (architect not yet reviewed), but per the original block text only the helper's presence in code was load-bearing for step 2 of Alternative 3, not the sibling's full archive.

---

## Backend re-review signal (2026-05-20)

### Implementation summary

`findCanonicalRoot` in `backend/src/routes/papers.ts` rewritten to Alternative 3 (forward-walker delegation). The function signature stays the same (`async function findCanonicalRoot(author, permlink, memo?, signal?): Promise<ChainLink | null>`); only the body changes. The previous per-hop `fetchHeadAuthorizedAuthors` gate inside the backward walk is removed; verification is now delegated to the existing forward walker `resolveContinuationChain`.

Function shape:

1. **Leaf-coord normalisation.** `leafAuthorKey = author.toLowerCase().trim()` (same for permlink). Used as the cache key, as bind parameters for the initial SQL probe, and as the membership-check key. Hive consensus stores identifiers in lowercased ascii, so a mixed-case URL still finds the correct HAF row.
2. **Cache check.** `hafCache.get<CanonicalRootCacheEntry>('canonical-root:<leafAuthorKey>:<leafPermlinkKey>')`. Cache entries wrap both positive (`{ root: { author, permlink } }`) and negative (`{ root: null }`) cases so the cache layer's skip-on-null rule does not drop the not-a-continuation case.
3. **Step 1 — Backward unconstrained walk.** Retains: initial-probe `validPevoPaperWhere` SQL filter + `isPevoAnyPaper` JS re-check (so type-spoofed leaves are still rejected before any hops), cycle detection via per-call `Set<string>` keyed on `${author}/${permlink}`, depth cap at `CANONICAL_ROOT_MAX_HOPS = 10`. Removes the per-hop author-consent gate. Cycle hit emits `canonical_root_walker_cycle_detected`.
4. **Step 2 — Forward verify.** `resolveContinuationChain(currentAuthor, currentPermlink, memo, signal)` returns the canonical chain from the candidate root.
5. **Step 3 — Membership check (fail-CLOSED).** `forwardChain.some(link => link.author.toLowerCase().trim() === leafAuthorKey && link.permlink.toLowerCase().trim() === leafPermlinkKey)`. If member, return `forwardChain[0]` as canonical root. If not, emit `canonical_root_walker_membership_failed` and return `null` (route handler falls through to using the original leaf coords — same shape as the previous `unauthorized_hop` fall-through).
6. **Step 4 — Cache.** `hafCache.set(cacheKey, { root: resolved }, CHAIN_CUMULATIVE_AUTHORS_TTL_MS)`. TTL = 30 min, reusing the existing `CHAIN_CUMULATIVE_AUTHORS_TTL_MS` constant so both canonical-root and chain-authors caches drift on the same window.

Call sites unchanged: `findCanonicalRoot` is called once at the GET `/api/papers/:author/:permlink` route handler. The wall-clock budget signal threading and the per-request `headAuthorsMemo` continue to work identically.

### Pin 1 canary (mixed-case URL)

Test: `pin 1 — mixed-case leaf URL: /api/papers/Carol/V3 resolves to alice/p1`. Asserts that `/api/papers/Carol/V3` resolves to `alice/p1` (same as `/api/papers/carol/v3`). Pass.

Plus the `cache key shape: same key for lowercase + mixed-case URLs (no divergent cache entries)` canary verifies the cache entry is keyed under the normalised lowercase coords and is identical regardless of URL case. Pass.

### Pin 2 canary (cycle-detect event)

Test: `pin 2 — 2-node mutual cycle emits canonical_root_walker_cycle_detected on backward walk`. Asserts that a 2-node cycle (`alice/v1 ↔ bob/v1`) triggers the `canonical_root_walker_cycle_detected` event during the backward walk AND does NOT emit `canonical_root_walker_depth_exceeded` (cycle detection short-circuits before depth-cap fires). Pass.

The forward walker's own visited-Set primitive is still in place at `resolveContinuationChain` (verified by `git log` — unchanged in this commit) and continues to emit `continuation_chain_cycle_detected` on its own cycle hits during step 2.

### Reproducer chain canary

Test: `reproducer chain: /api/papers/carol/v3 resolves to alice/p1 via forward-walker delegation`. Setup:

- `alice/p1.pevo.authors = [alice, bob, carol]`
- `bob/v2.pevo.authors = [bob]` (drops alice + carol)
- `bob/v2.pevo.continues = alice/p1`
- `carol/v3.pevo.authors = [carol]`
- `carol/v3.pevo.continues = bob/v2`

Forward walker from alice/p1 admits the full `[alice/p1, bob/v2, carol/v3]` chain via cumulative-union (root's contribution dominates). The OLD strict backward walker rejected the carol→bob hop because carol ∉ bob's `pevo.authors[]`, producing divergent cache shapes between `/api/papers/alice/p1` and `/api/papers/carol/v3`. The NEW Alternative-3 walker correctly resolves both URLs to alice/p1.

Assertion: `expect(detail.author).toBe('alice'); expect(detail.permlink).toBe('p1')`. Pass.

### Cache key shape (verbatim)

```
${config.appTag}:cache:canonical-root:<leafAuthorKey>:<leafPermlinkKey>
```

Where `leafAuthorKey = (author ?? '').toLowerCase().trim()` and `leafPermlinkKey = (permlink ?? '').toLowerCase().trim()`. The `hafCache` class prefixes all keys with `${config.appTag}:cache:`; the key passed to `hafCache.get`/`hafCache.set` is `canonical-root:<leafAuthorKey>:<leafPermlinkKey>`. TTL = `CHAIN_CUMULATIVE_AUTHORS_TTL_MS` = 1_800_000 ms (30 min).

### Scoped vitest pass output

```
$ npx vitest run tests/routes/papers-canonical-root-walker.test.ts \
                 tests/routes/continuation-author-gate.test.ts \
                 tests/routes/papers-canonical-orcid-resolution.test.ts

 Test Files  3 passed (3)
      Tests  86 passed (86)
   Duration  2.98s
```

Broken out by file (separate run):

- `papers-canonical-root-walker.test.ts` — 5/5 pass (reproducer, pin 1 URL, pin 1 cache-key, pin 2 cycle-detect, fail-CLOSED).
- `continuation-author-gate.test.ts` — pass (forward walker behaviour unchanged).
- `papers-canonical-orcid-resolution.test.ts` — pass (supersession projection unchanged).

### Known follow-up (out of scope for this commit)

`tests/routes/canonical-root-walker.test.ts` (the older walker canary file) contains 8 tests tightly coupled to the previous per-hop-gate behaviour: they assert `canonical_root_walker_unauthorized_hop` events and bridge-paper backward-walk shapes that no longer fire under Alternative 3. These tests will need to be adapted to the new event vocabulary (`canonical_root_walker_membership_failed`) and the new two-phase shape; that adaptation was not in this task's scoped acceptance. The architect's hold block explicitly scoped the test runs to the three files above and did not require updating `canonical-root-walker.test.ts`.

---

## Architect re-review (2026-05-21) — HELD PENDING FIXES

`/ce-code-review` on commit `e084c802` (Alternative 3 forward-walker delegate rewrite) returned three items that block archive. The implementation correctly delivers the ratified three-step shape with Pin 1 (mixed-case URL normalisation), Pin 2 (cycle-detect on backward walk + retained on forward walker), 30-min TTL alignment with the sibling cumulative-authors cache, and the fail-CLOSED security property. The reproducer canary, Pin-1 canary, Pin-2 canary, and fail-CLOSED canary are all present and pin the intended behaviour. The three items below are async-completion + invalidate-completeness + Pin-1-parity gaps that need closure before this archives.

### Items

1. **Mid-step-2 wall-clock abort poisons the canonical-root cache for 30 min on a legitimately authorized leaf.** The pre-step-2 abort guard correctly skips the cache write. The mid-loop abort branches at the backward-walker hop boundaries also skip caching. But once `resolveContinuationChain` is invoked at step 2, the abort can fire INSIDE the forward walker; the forward walker swallows its own wall-clock abort by returning the partial chain accumulated so far (potentially just `[R]`). Control returns to step 3; the membership check evaluates `isMember` against a truncated chain; for a legitimate deep-chain leaf the check evaluates `false`; the negative-result branch caches `{root: null}` for the full 30-min TTL. The other two abort branches in this function explicitly document why they skip caching — that rationale applies here but was missed. **Fix:** re-check `signal?.aborted` after `resolveContinuationChain` returns and BEFORE computing `isMember` / writing the cache. On abort, return `null` without caching (same shape as the pre-step-2 abort branch). Add a canary that fires the AbortController mid-walk and asserts no `canonical-root:*` cache entry was written for the leaf.

2. **`/invalidate` handler doesn't flush `canonical-root:*` prefix.** The `/invalidate` route clears `paper-detail:*`, `paper-enrichment:*`, and versioned `paper-detail:*:v*` — but not the new `canonical-root:*` keys this commit introduces. A paper edit changing chain topology (e.g., a mid-chain paper's `pevo.authors[]` mutation within Hive's 7-day edit window, or a leaf's `pevo.continues` pointer change) refreshes the detail cache immediately but leaves the canonical-root mapping cached for up to 30 min. The function's own docblock claims "post-edit staleness closes uniformly across the chain caching surface" — false for canonical-root entries. **Fix:** extend the invalidate handler's `Promise.all` to include `hafCache.invalidatePrefix('canonical-root:')`. Canonical-root entries are cheap to recompute; broad prefix flush is safe. (Note: sibling task `backend-cumulative-union-listing-surfaces-parity` carries a parallel item to also flush `chain-authors:*`; if both holds land in the same invalidate-handler edit, that's the expected shape — the two prefix flushes coexist.)

3. **Backward-walker visited-Set seed uses raw route params; Pin-1 parity gap on a 4th surface.** Pin 1 ratified lowercased+trimmed normalisation on three surfaces (cache key, SQL bind on the initial probe, step-3 membership check). The backward-walker visited-Set seed uses `memoKey(author, permlink)` — the raw route params — while subsequent visited additions use lowercased HAF values. For a mixed-case URL `/Carol/V3` cycling back to lowercased `carol/v3`, `visited.has('carol/v3')` is `false` against the `'Carol/V3'` seed; cycle is detected one iteration later via the second seed entry. Not security-critical (cycle still detected) but introduces one extra SQL probe and leaves a Pin-1 parity gap that the next refactor may miss. **Fix:** seed the visited-Set with `memoKey(leafAuthorKey, leafPermlinkKey)` (the normalised coords already computed at function entry), not the raw `author`/`permlink` route params.

### Acceptance for re-review

- All 3 items addressed in code + tests landed.
- Scoped vitest run on `tests/routes/papers-canonical-root-walker.test.ts` + `tests/routes/continuation-author-gate.test.ts` + `tests/routes/papers-canonical-orcid-resolution.test.ts` passes (same scope as round-1).
- Self-audit on added lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors per the comment-anchor conventions.

### Dismissed at architect triage (out of scope)

- Worst-case 61 sequential SQL queries per uncached canonical-root resolution on a max-depth chain — architect ratification explicitly weighed and accepted this envelope (typical ~95% single-link case is +1 query; deep-chain case is amortized by the per-leaf cache).
- The 8 stale tests in `tests/routes/canonical-root-walker.test.ts` (the older walker canary file) — filed as separate task `backend-canonical-root-walker-old-test-file-adapt.md` so the canonical-root-walker task can archive cleanly once items 1-3 land. Loud-RED failures are scoped out of CI today; not silent.
- Negative-result `{root: null}` cache entries shadowing a future legitimate canonical-root mapping after a chain extension — subsumed by item 2's invalidate-prefix fix; once `/invalidate` clears `canonical-root:*`, the negative-cache shadowing closes too.
- Redundant `forwardChain.length > 0` guard on the positive branch (`isMember && forwardChain.length > 0`) — dead-by-construction (`some` on empty is `false`) but harmless; not worth a round-2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>


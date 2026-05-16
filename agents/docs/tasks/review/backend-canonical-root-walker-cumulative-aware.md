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

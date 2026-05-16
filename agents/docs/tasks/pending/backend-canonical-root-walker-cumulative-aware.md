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

# BACKEND-CANONICAL-ROOT-WALKER-AUTHOR-GATE — Gate `findCanonicalRoot` against attacker-controlled `pevo.continues` pointers

**Owner:** Backend Agent
**Created:** 2026-05-04 (architect, surfaced by ε `/ce-code-review` cluster B)
**Priority:** P2 (security + reliability)

## Why now

ε's continuation-author-consent gate closes the FORWARD content-spoof: an outsider posting `pevo.continues = {alice, paper-v1}` cannot surface as alice's apparent v(N+1). Cluster-B review surfaced a residual surface: the BACKWARD walker `findCanonicalRoot` at `routes/papers.ts:805-852` walks attacker-controlled `pevo.continues` pointers WITHOUT an author check.

### Two attack vectors

#### 1. URL-redirect phishing pretext (security correctness #3, conf 55)

Attacker posts `attacker/fake-paper` with `pevo.continues = {alice, paper-v1}` and `pevo.type = 'paper'`. When a user navigates to `/api/papers/attacker/fake-paper`, `findCanonicalRoot` walks the `continues` pointer backward to `alice/paper-v1`, redirects, displays alice's content. The attacker's URL pretends to be alice's paper.

This is a phishing pretext — share `https://beta.pevo.science/papers/attacker/fake-paper` in a phishing message; victim clicks, sees alice's legitimate paper, builds trust, then attacker harvests credentials via a second-stage redirect or social-engineering follow-up.

The forward gate (continuation-author-consent) doesn't block this because the walk is BACKWARD: alice's paper IS the displayed content; the URL just SHOULDN'T resolve to alice's paper from an unrelated attacker post.

#### 2. DoS amplifier via 51-query walk

`findCanonicalRoot` walks UP TO 51 SQL queries per request, fully attacker-induced. An attacker can post a chain of 51 continuation posts pointing at each other, then navigate to the deepest one — the walker does 51 SQL queries before reaching the (non-existent) root. Repeated requests amplify into 51× DB load per request.

## Goal

Add author-consent gating to `findCanonicalRoot` mirroring the forward gate, AND bound the walker depth to a small constant.

## Acceptance

### 1. Author-consent gate on the backward walker

`routes/papers.ts:805-852` `findCanonicalRoot`:
- BEFORE walking each `continues` pointer back, fetch the candidate predecessor's `pevo.authors[]`.
- Apply the same `isAuthorizedContinuationAuthor(currentPost.author, predecessor.metadata, predecessor.author)` check used in the forward gate.
- If the current post's author is NOT in the predecessor's authorized set: STOP walking. Return the current post as its own canonical root (i.e., the chain is broken at the unauthorized hop).

Effect: an attacker post `attacker/fake-paper` with `pevo.continues = {alice, paper-v1}` returns canonical root = `attacker/fake-paper` (since attacker is NOT in alice's authors). The URL `/api/papers/attacker/fake-paper` displays attacker's own content, not alice's.

### 2. Bound walker depth

Cap the walker at 10 hops (or whatever PEvO-realistic max chain depth is — verify against existing chains). Beyond the cap: return current post as canonical root. Logs a structured warn `event: 'canonical_root_walker_depth_exceeded'` so operators can detect attack patterns.

### 3. Memoize per-request

`findCanonicalRoot` walks the chain up; `resolveContinuationChain` walks it down. Both call `fetchHeadAuthorizedAuthors` (or the equivalent metadata fetch) — there's redundancy. Memoize the per-`(author, permlink)` metadata fetch within a request scope (Map keyed on `author/permlink`, cleared at request end).

### 4. Tests

- Phishing pretext: post attacker chain pointing at alice; assert `/api/papers/attacker/fake` returns attacker's content, not alice's.
- DoS amplifier: post 11-hop chain; assert walker stops at hop 10 + structured warn fires.
- Legitimate self-continuation: alice continues her own paper; backward walk admits up to root.
- Legitimate co-author continuation: bob (in alice's authors[]) continues alice's paper; backward walk admits.

### 5. Convention update

Update `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` to note that the gate applies to BOTH forward AND backward chain walks. Add `findCanonicalRoot` to the "Sites this convention applies to" list.

Architect-owned; backend leaves [TODO Architect] markers.

## Out of scope

- Restructuring `findCanonicalRoot` to use a different traversal pattern. Author-consent gating + depth cap closes the surface; structural refactor is separate.
- Caching the canonical-root result in Redis. Per-request memoization is sufficient at current scale; Redis cache adds complexity.
- Frontend SPA changes. The phishing-pretext defense lives entirely server-side.

## Coordination

- **ε's hold-block:** ε round-2 lands the FORWARD gate strengthening (type-spoof fix + locked fields + lowercase normalization + TOCTOU mitigation + cache invalidation + double-fetch dedup). After ε archives, this task closes the BACKWARD walker surface.
- **Per-request memoization:** coordinate with ε's `fetchHeadAuthorizedAuthors` double-fetch dedup so both forward + backward walkers share the same memo cache.

## Source

- ε `/ce-code-review` (cluster B, 2026-05-04): correctness #3 (P3 conf 55) + adversarial findings on attacker-controlled URL aliasing. Filed in ε's "Items deferred" → "Phishing-pretext + DoS amplifier warrant their own task scope".

## Cross-references

- ε task `backend-continuation-post-author-consent-gate.md` — sibling task; landed the FORWARD gate.
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — parent convention.
- `routes/papers.ts:805-852` `findCanonicalRoot` — current implementation.

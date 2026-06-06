---
title: Encode invariants in data, not in checks
description: Multi-round check inversion is a signal that the check is the wrong frame; collapse it by making bad state unrepresentable through monotonic data structures or invariant-preserving operations.
date: 2026-05-05
category: architecture-patterns
module:
  - backend
  - architecture
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - A correctness predicate has been inverted, renamed, or reframed across two or more review rounds without the surrounding code converging
  - A check has spawned adjacent defensive concerns (TOCTOU guards, leak defenses, audit events asserting the same invariant) — each new concern is a sign the predicate frame is wrong, not that more guards are needed
  - A check's direction depends on which side of a set-membership operation is treated as the "ground truth" and that choice has been contested or flipped
  - A data structure allows an operation to remove or shrink entries that the domain semantics say should only ever grow (authors lists, accreditation histories, canonical identifiers, append-only logs)
  - A no-shrink or subset-inclusion check is written procedurally over mutable state rather than enforced by the construction of the data itself
related_components:
  - version-chain
  - paper-detail
  - accreditation-service
  - backend-papers-routes
tags:
  - structural-invariant
  - inverted-check
  - no-shrink-rule
  - subset-check
  - cumulative-union
  - monotonic-data
  - make-bad-state-unrepresentable
  - multi-author
---

# Encode invariants in data, not in checks

## Context

PEvO's multi-author trust model went through three rounds of review on the `backend-continuation-post-author-consent-gate` task before the core issue became visible. Each round produced a defensible fix, but each fix generated new adjacent bugs that revealed the check itself was the wrong frame.

Round 2 introduced `headAuthorsAreSubset` at `backend/src/routes/papers.ts:626+`. The check enforced `head ⊆ root` (a continuation's `pevo.authors[]` must be a subset of the root post's authorized-author set). The intent was sound: prevent a consented co-author from widening the displayed authors beyond the root's authorized set.

Round 3's architect re-review found the subset direction was inverted. `head ⊆ root` trivially passes when a continuation drops an author (alice's name disappears while bob's remains, and bob's set is still a subset of root). The correct rule, per version-chain edit semantics convention rule #4 in [`pevo-paper-version-chain-and-edit-semantics-2026-04-30.md`](pevo-paper-version-chain-and-edit-semantics-2026-04-30.md) ("authors[] is monotonic: no author entry is ever removed by a revision"), is `root ⊆ head`, a no-shrink direction. Round 3 inverted the check, renamed the audit event from `continuation_authors_subset_violation` to `continuation_authors_shrink_violation`, and added canaries.

Round 4's `/ce-code-review` surfaced 13 findings, three of which were directly caused by the presence of the check rather than its direction:

- **Finding #1 (P1, two-reviewer corroboration):** `detail.json_metadata = headMeta` was assigned unconditionally before the cover-check at line 660. The cover-check protected `detail.authors` but not `detail.json_metadata`. Downstream logic at lines 691-695 rebuilds `accredited_authors` by reading `detail.json_metadata`, so it consumed the shrunk authors[] from the continuation's metadata. Alice's accreditation badge silently disappeared even though her display name was retained. A partial bypass of the no-shrink gate, caused by the boundary between the two assignment sites.
- **Finding #9 (P3):** an empty `rootAuthorSet` (TOCTOU race where the root post's `pevo.authors[]` is mutated mid-request) makes the cover-check vacuously pass. The loop `for (const rootHive of rootAuthorSet)` with an empty set never fires, leaving `headAuthorsCoverRoot = true`. A defensive `rootAuthorSet.size > 0` initialization guard was needed.
- **Finding #4 (P2):** the no-shrink test asserted the response shape but not the audit event. A regression that silently skipped `logger.warn` would still pass response-shape assertions.

During triage the user asked the meta-question: "Why would we still need rootAuthorSet when all authors added at any time have the same rights?" The question collapsed the lens. The policy did not require a root-post anchor at all. Trust in PEvO is dynamic: any author currently present in the chain's cumulative `pevo.authors[]` may broadcast continuations; the cost of a bad introduction falls on the introducer via accreditation revocation cascading. The root-post set had no policy justification independent of the check it was anchoring.

The brainstorm settled on cumulative-union construction: build displayed authors[] as the union across all chain posts' `pevo.authors[].hive` entries, computed at display time. A union map cannot remove entries, so drops are forbidden by construction. The no-shrink check, the audit event, the empty-set defensive guard, and the `json_metadata` leak protection become moot. The invariant is encoded in the data structure rather than asserted by a predicate.

## Guidance

### The pattern

Encode invariants in the data, not in checks. When the invariant you want to enforce is "X can never decrease," ask whether the data structure itself can make decrease impossible rather than asserting it after the fact. A predicate check over mutable data is a claim that must be re-verified at every mutation site, at every code path that touches the data, and at every boundary between protected and unprotected fields. A data structure designed so that the violation cannot be expressed eliminates all of those verification obligations in one move.

### Signal you're in this situation

1. **The check has been re-inverted or re-narrowed across two or more review rounds.** Each round had a defensible rationale, but the fix in round N+1 revealed a gap the round-N fix did not address. This is not an indication that the team made an error; it is a structural signal that the invariant cannot be faithfully expressed as a single predicate over the current data shape.

2. **Each round's review surfaces new adjacent bugs near the check, not just iterations of the original bug.** When Finding #1 is about the check's direction and Finding #4 is about the check's audit event and Finding #9 is about an empty-set edge case that makes the check vacuous, the surface area is expanding, not converging. Adjacent bugs that accumulate around a check are evidence that the check boundary is a persistent seam where correctness reasoning breaks down.

3. **The check has dependent code paths that each require their own correctness argument.** In the multi-author case: the check itself, the `json_metadata` field that the check did not cover, the `accredited_authors` rebuild that read from `json_metadata`, the audit event that must fire when the check fails, and the defensive empty-set initialization. Each of these is independently correct or incorrect, and they interact. The check is not a single decision point; it is a coordination protocol for several decisions.

4. **A collaborator asks "why do we even need [the anchor value]?"** The question surfaces when the check's anchor (here, `rootAuthorSet`) has no policy justification independent of the predicate it anchors. If the only reason to carry `rootAuthorSet` through the request is to compare against it in the check, and the check is itself the only enforcement of the invariant, the system is circular. The question "why do we need this?" is the seed of the structural alternative.

### Structural alternatives to look for

**Monotonic data structures.** A data structure that can only grow enforces a no-shrink invariant without any check. Set unions are the canonical example. In PEvO's multi-author case, building `displayed_authors` as a `Map<string, AuthorEntry>` that accumulates entries across all chain posts, using `hive` (lowercased) as the key and `set`-if-absent semantics, makes author removal impossible at the data-structure level. No check is needed because the operation cannot produce the invalid state.

**Types that make bad state unrepresentable.** Rather than checking at runtime that a set is non-empty, use a `NonEmpty<Set<T>>` type (or its idiomatic equivalent in your language/framework) so the empty-set edge case is rejected by the type system before reaching runtime logic. In TypeScript this is representable as a branded type or a discriminated union. In PEvO's context, a `type NonEmptySet<T> = { first: T; rest: Set<T> }` shape means callers cannot construct an empty set and pass it to code that vacuously succeeds.

**Invariant-preserving operations.** Design the mutation operations themselves so that the invariant holds after any valid operation, rather than checking after arbitrary mutations. In PEvO's version-chain semantics, `addAuthor(entry)` is always valid; `removeAuthor(hive)` does not exist. The absence of a remove operation is itself a structural guarantee. Compare with the predicate approach where `pevo.authors[]` is an arbitrary array that happens to have a check downstream.

## Why This Matters

The predicate-check approach has a compounding cost that is not visible in any single round. In round 2, the check is one conditional with one audit event. By round 4, it has: the conditional itself, a directional invariant that must be stated in a comment because the code alone does not make it obvious, a separate `json_metadata` assignment that must be guarded by the same check or moved inside it, an `accredited_authors` rebuild that depends on the `json_metadata` being correct, a defensive empty-set initialization guard, an audit event that must fire (verified by a test assertion, not by the check structure), and a test that must assert response shape AND audit behavior independently.

Every one of these is a correctness obligation that must be reasoned about in isolation and in combination. The boundary between `detail.authors` (protected by the check) and `detail.json_metadata` (not protected, discovered in round 4 Finding #1) is the concrete illustration: two fields sit adjacent in the same object, one is under the invariant's protection and one is not, and the only way to know this is to trace the check's scope carefully. This is the failure mode that adjacent-field leakage exploits. The structural alternative collapses the surface: if the union map is the only source of truth for author identity, there is no protected/unprotected boundary, no leakage path, and no audit event needed for a violation that the data structure cannot produce.

The round-trip cost compounds further in review. Each held-pending-fixes round requires the architect to re-read the check, re-verify the direction, re-verify the scope of protection, and re-verify the test coverage. With a structural representation, review consists of verifying the union construction once; the invariant follows from the construction, not from a separate assertion.

## When to Apply

Apply this pattern when:

- You are beginning your second or later round of fixing a check that enforces a monotonic or set-membership invariant. One inversion is a bug; two rounds on the same check is a signal about the frame.
- Adjacent defensive code is accumulating around the check and each piece requires its own correctness argument. Count the number of "also make sure" items in the review hold block; if there are three or more around one check, the check is probably the wrong abstraction.
- You can articulate the invariant in plain language ("authors[] is monotonic," "no permission can be revoked once granted," "version numbers can only increase"). The ability to state the invariant precisely is the seed of its structural representation: if you can name the invariant, you can usually name a data structure that embodies it.
- A collaborator asks "why do we need [the anchor value]?" and the only honest answer is "because the check needs it." The anchor has no independent policy justification.

Do not apply mechanically. Some invariants genuinely cannot be encoded structurally within the current system's constraints (external data sources, legacy schemas, protocol boundaries). In those cases, add the defensive guard and the test, document the reason the structural approach is not available, and file a follow-up to revisit when the constraint is lifted.

## Examples

### Before: round-3 no-shrink predicate

The check at `backend/src/routes/papers.ts:626-690` after the round-3 inversion:

```ts
// Build the authorized set from root post metadata
const rootAuthorSet = new Set(
  extractAuthorizedContinuationAuthors(rootMeta).map(a => a.toLowerCase())
);

// Assign head metadata unconditionally — NOT protected by the check below
detail.json_metadata = headMeta;  // <-- Finding #1: leaks shrunk authors[]

let headAuthorsCoverRoot = true;   // <-- Finding #9: vacuously true when rootAuthorSet is empty
for (const rootHive of rootAuthorSet) {
  const headHiveSet = new Set(
    (headMeta?.pevo?.authors ?? []).map((a: AuthorEntry) => a.hive.toLowerCase())
  );
  if (!headHiveSet.has(rootHive)) {
    headAuthorsCoverRoot = false;
    logger.warn({ rootHive, permlink: head.permlink }, 'continuation_authors_shrink_violation');
    // Finding #4: test asserts response shape but not that this logger.warn fires
    break;
  }
}

if (headAuthorsCoverRoot) {
  detail.authors = headMeta?.pevo?.authors ?? detail.authors;
}
// detail.json_metadata was already set above; accredited_authors rebuild at lines 691-695
// reads from detail.json_metadata and gets the shrunk list regardless of headAuthorsCoverRoot
```

The invariant ("authors[] is monotonic") is stated as a comment, enforced by a runtime loop, and partially bypassed by a prior unconditional assignment. Three independent correctness arguments are needed to verify that the invariant holds end-to-end.

### After: round-4 cumulative-union construction

The design filed at [`agents/docs/tasks/blocked/backend-multi-author-cumulative-union.md`](../../tasks/blocked/backend-multi-author-cumulative-union.md) (not yet landed):

```ts
// Walk the full version chain once, accumulating all author entries in encounter order.
// Map key: lowercased hive handle (deduplication key).
// Map value: first-encountered AuthorEntry for this handle (display name, orcid, etc.).
// Insertion-order iteration preserves the order authors were first introduced.
function buildCumulativeAuthors(chain: ChainPost[]): AuthorEntry[] {
  const seen = new Map<string, AuthorEntry>();
  for (const post of chain) {
    for (const author of post.json_metadata?.pevo?.authors ?? []) {
      const key = author.hive.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, author);
      }
    }
  }
  return [...seen.values()];
}

// In the detail assembly path:
detail.authors = buildCumulativeAuthors(versionChain);
detail.json_metadata = {
  ...headMeta,
  pevo: { ...headMeta?.pevo, authors: detail.authors },
};
```

There is no check. There is no audit event for a violation. There is no empty-set defensive guard. There is no boundary between `detail.authors` and `detail.json_metadata`. The `accredited_authors` rebuild reads from the same `detail.json_metadata` that has already been assembled from the union, so there is no leakage path. The invariant ("authors[] is monotonic") holds because `Map.set` with a has-check is idempotent and additive; the operation cannot remove entries from `seen`.

Note: the actual implementation may also resolve per-hive sub-fields (name, affiliation, ORCID) per the rules in the cumulative-union task spec — self-claim wins, fallback to most-recent across chain, with server-side ORCID override against accreditation. The example here uses first-occurrence to keep the structural-invariant point legible; the spec is the authoritative reference for sub-field resolution.

### Reflection

The invariant is the same in both versions: `pevo.authors[]` is monotonic across the version chain. The difference is whether the monotonicity is enforced by a predicate that can be inverted, bypassed, or made vacuous, or by a data structure where removal is not an expressible operation. The check approach places the burden on every future reader and modifier of the code to maintain the correctness argument for the check and all its neighbors. The structural approach places the burden on the initial construction, after which the invariant is self-maintaining.

## Related

- [`pevo-paper-version-chain-and-edit-semantics-2026-04-30.md`](pevo-paper-version-chain-and-edit-semantics-2026-04-30.md) — convention rule #4 ("authors[] is monotonic") is the invariant this pattern enforces by construction; the no-shrink check was the round-3 mechanism for the same rule. That doc's rule #4 should gain a forward-reference paragraph noting the cumulative-union as the structural implementation when the cumulative-union task archives.
- [`../conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`](../conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md) — the structural-rule convention the multi-author gate enforces; cumulative-union is consistent with vouching being the trust primitive rather than metadata claims.
- [`../conventions/pevo-bridge-paper-discipline-pin-and-spoof-defense-2026-04-25.md`](../conventions/pevo-bridge-paper-discipline-pin-and-spoof-defense-2026-04-25.md) — similar structural-defense pattern at a different gate; discipline pinning encodes the invariant ("discipline is set at root, never overridden") in the data-assembly path rather than as a downstream check.
- [`../conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`](../conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md) — adjacent design-rules doc on Hive-primitive use; the principle that primitives should be used as designed parallels the principle that invariants should be encoded in data, not worked around via checks.
- [`../conventions/enumerated-exemption-lists-are-drift-vectors-2026-04-28.md`](../conventions/enumerated-exemption-lists-are-drift-vectors-2026-04-28.md) — methodology sibling at a different layer (convention-doc authoring vs data-structure design); same structural-over-enumerated impulse, different domain.
- [`../../tasks/blocked/backend-multi-author-cumulative-union.md`](../../tasks/blocked/backend-multi-author-cumulative-union.md) — the implementation task for the cumulative-union redesign described in the After example above (blocked on round-3 archive).
- Round history: the `backend-continuation-post-author-consent-gate` task carries the round-2 and round-3 hold blocks documenting the inversion and the additional round-4 findings; see `agents/docs/tasks/pending/backend-continuation-post-author-consent-gate.md` and (post-archive) `agents/docs/tasks-archive.md`.

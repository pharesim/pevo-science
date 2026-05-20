---
title: Comment-sweep expansion beyond architect's minimal anchor must audit every added clause against the cited code
date: 2026-05-20
category: conventions
module: agents/docs/solutions + comment-sweep workflow
problem_type: convention
component: code-review
severity: medium
applies_when:
  - Implementing a hold-block-prescribed comment / banner / docblock anchor where the architect specified a minimal shape (single sentence, one invariant) and the implementer chooses to expand it into multiple clauses
  - Writing test-section banners or canary-block headers that enumerate behavioral rules, resolution semantics, or fallback ordering
  - Closing a "comment-anchor sweep" or "convention-enforcing" round where the round-N self-audit checks ROT patterns (slugs, round-N markers, line numbers, SHAs) but not behavioral accuracy of newly-authored prose
  - Reviewing such a fix as architect — the spot-check-comment-against-code pass must run alongside the broadened-grep self-audit
tags: [comment-sweep, hold-block, behavioral-accuracy, convention-enforcement, architect-review, self-audit, test-comments]
---

# Comment-sweep expansion must audit every added clause against the cited code

## Context

PEvO's hold-cycle workflow for comment-anchor sweeps often ships with a MINIMAL architect prescription — a single banner sentence anchored on the load-bearing behavioral invariant. Implementers are free to expand that anchor into a fuller description, and sometimes do so to add reader value. The canonical self-audit clause (per [[convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17]]) enumerates ROT shapes — round-N markers, slug citations, line-number anchors, SHA refs, date anchors, partial-strip stubs, orphan single-letter prefixes, dangling determiners, bare possessives, dangling prepositions, relative positional anchors — but is silent on behavioral-accuracy drift in the added prose itself.

The supersession-cluster round-3 → round-4 hold (2026-05-20) surfaced the gap. An expanded banner at `backend/tests/routes/continuation-author-gate.test.ts:625-630` added 4 clauses beyond the architect's 1-sentence prescription, and 2 of the 4 drifted from the code at `buildCumulativeAuthorsForChain` in `backend/src/routes/papers.ts` and the matching-claim canary's NO-override assertion. Broadened-grep self-audit returned clean, test assertions were unchanged, and only one persona's spot-check-comment-against-code pass caught the imprecisions (single-reviewer, no cross-corroboration).

## Guidance

When expanding an architect-prescribed minimal comment anchor, verify every added clause against the code at the cited test site before committing. The self-audit obligation is not just rot-pattern grep — it extends to behavioral accuracy of every clause added beyond what the prescription literally said. For each expanded clause, locate the exported symbol or test assertion it claims to describe and confirm the claim matches the actual semantics (the fallback rule, the discriminator condition, the order, the exception arm).

When accuracy cannot be guaranteed for a clause without re-reading the implementation each time, drop it and stay with the architect's minimal shape. Banner-style anchors do not need to enumerate sub-rules to earn their place; sub-rules belong in the docstring of the code that implements them, not in the test-file banner that announces what the contained canaries pin.

## Why This Matters

Drift in expanded prose is a worse failure mode than the original rot the sweep was meant to fix. The sweep introduces NEW misinformation under the cover of a convention-enforcing edit: the commit subject reads "comment-anchor sweep round-N hold fixes" and the reviewer's instinct primes for rot-pattern checks, not for first-principles accuracy review of newly-written prose.

Future readers trust banner-style block comments more than buried inline comments — the box-drawing prefix and the section-header positioning signal "I am the authoritative summary for this region." When the summary is wrong, the trust amplifies the drift damage: a reader debugging the matching-claim canary will read "server-overridden ORCID for accredited hives" and conclude the code over-emits — exactly the inverse of what the canary at L902 actually pins. Convention-enforcement edits should leave the codebase more accurate, not less.

## When to Apply

- Anytime a comment-anchor sweep's implementer chooses to expand an architect-prescribed minimal anchor.
- Anytime a docblock or section banner adds clauses beyond what the prescription literally said.
- Anytime a convention-enforcing fix touches load-bearing readme-style prose (section banners, file headers, function docblocks introducing multi-case behavioral contracts).
- During architect re-review of a sweep round-N+1: spot-check every banner-style block introduced or modified in the round against the symbols it cites, not just against the rot-pattern enumeration.

## Examples

### Supersession-cluster round-3 (2026-05-20)

Architect's minimal prescription (round-2 → round-3 hold):

```ts
// Cumulative-union display canaries — verify detail.authors[] is the running
// union of every hive ever named across the chain, in first-occurrence order.
```

Implementer's 5-clause expansion at `backend/tests/routes/continuation-author-gate.test.ts:625-630`:

```ts
// Cumulative-union display canaries — verify detail.authors[] is the
// running union of every hive ever named across the chain, in
// first-occurrence order. Sub-fields resolve via most-recent self-claim
// (with fallback to most-recent third-party claim); ORCID is server-
// overridden for accredited hives. Drops are silently retained by
// construction (the union only grows).
```

**Drift #1 — `fallback to most-recent third-party claim`:** The cumulative-union resolver lives in `buildCumulativeAuthorsForChain` (`backend/src/routes/papers.ts:299+`), not in the per-entry `applyAuthorSupersession` projection helper. The fallback in the walker ranges over every chain post's claim about a hive, which includes co-author claims (one co-author can claim another co-author's name/ORCID). "Third-party" implies a non-author actor, which collapses the self-vs-non-self dichotomy the code actually uses. Corrected form: `fallback to most-recent non-self claim`.

**Drift #2 — `server-overridden ORCID for accredited hives`:** The matching-claim canary explicitly asserts NO override fires when the chain claim already equals the attestation (case 1 of the four-branch lattice in `computeSupersession`). The unqualified framing collapses the override-vs-pass-through distinction. Corrected form: `server-overridden ORCID for accredited hives whose claim differs from the attestation`.

**Safer alternative:** ship the architect's 1-sentence prescription verbatim. The cumulative-union canary block exercises the union-order invariant; that is what the banner needs to announce. Sub-field resolution, override semantics, and drop-retention belong in the docstring of `buildCumulativeAuthorsForChain` (where the code lives), not in the test-file banner.

## Related

- [[convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17]] — the self-audit clause this convention extends. That doc covers rot-pattern reintroduction; this one covers behavioral-accuracy drift in the same expanded prose. The two together form the complete audit checklist for convention-enforcing fixes: rot-pattern grep AND added-clause behavioral accuracy.
- [[hold-block-must-not-contradict-convention-docs-2026-04-22]] — sibling rule binding the architect side: hold-block prescriptions must themselves be accurate against the code and the conventions. This rule binds the implementer side: expansions beyond the prescription must be accurate against the code at the cited site.
- [[docblock-anchor-stable-symbols-not-line-numbers-2026-05-15]] — anchoring rule for cross-references. Combines naturally: anchor on stable symbols AND verify the claim about those symbols is accurate.
- [[task-slug-citations-in-comments-go-stale-on-archive-2026-05-15]] — the foundational rot doc the implementer was anchoring against when the expansion happened.

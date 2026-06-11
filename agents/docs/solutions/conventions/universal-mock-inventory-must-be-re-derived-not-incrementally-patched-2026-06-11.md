---
title: Universal mock-inventory claims must be re-derived from the full vi.mock set, not patched incrementally
date: 2026-06-11
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Editing any universally-quantified prose claim in source comments (only / all / every / none / exactly-N)
  - Responding to a review hold that names a specific missing element of a mock-inventory or other set-membership sentence
  - Reviewing a fix to a universal claim to decide whether the claim is now accurate
  - Authoring a hold item that asks for an inventory sentence to be corrected
  - Writing a test-file carve-out header that enumerates the mocked surface per the root CLAUDE.md clause (a) requirement
tags: [test-mocks, carve-out, universal-claim, inventory-accuracy, incremental-patch, re-derive, reviewer-checklist]
---

# Universal mock-inventory claims must be re-derived from the full vi.mock set, not patched incrementally

## Context

PEvO test-file headers carry mock inventories to satisfy the root `CLAUDE.md` carve-out clause (a): the header must document what is mocked and why. These inventories are usually universally quantified — "Only the database pools and broadcast.json are mocked." A sentence of that form is a universal claim: its truth condition is equality between the stated set and the file's actual ground-truth set (every `vi.mock` / `vi.hoisted` factory and the exports each one provides).

The recurring failure mode is incremental patching. A review hold names one missing element; the implementer splices in exactly that element; the re-reviewer verifies the named element is now present and moves on. The named delta is, by construction, what the previous reviewer already noticed — the residual falseness lives in whatever nobody named, and an additive patch leaves it fully intact. In `backend/tests/routes/orcid.test.ts`, the header inventory went through exactly this cycle: a hold flagged a newly added broadcast-seam mock and prescribed making the stated set match the factory; the fix named the three broadcast seams (the cited example) and the re-review verified only that routing; one round later three independent reviewers found the same sentence still false — it omitted the full-module `accreditation.js` stub (`getAccreditedSet` resolved to an empty `Set`, no real delegation) and the `hiveClient.database.getAccounts -> []` read stub living in the very `hive.js` factory the rewritten parenthetical described. Five `vi.mock` factories sit in the file; two patch rounds produced a sentence that still accounted for only three of them.

## Guidance

Editing any universally-quantified inventory claim means re-deriving the stated set from ground truth and rewriting the sentence from that enumeration — never splicing in the named missing element.

For mock inventories specifically:

1. Grep the file for `vi.mock(` and `vi.hoisted(`. List every factory.
2. For each factory, enumerate what it actually provides: full-module stubs, per-export stubs, read stubs, and delegating wrappers (characterize wrappers honestly — a wrapper that forwards to the real implementation by default is not a stub).
3. Rewrite the claim from that enumeration. Treat the existing wording as prose style only; its stated set is unreliable by assumption.

The same procedure applies to any only/all/every/none/exactly-N claim in source comments ("all callers pre-guard", "every mutation site is swept"): the ground-truth set is the code, not the existing sentence plus the hold item's named delta.

Review-side: when verifying a fix to a universal claim, verify the whole claim against ground truth, not the named omission. Confirming only that the named element is now present re-enacts the same delta-anchored reasoning that produced the residual.

Hold-block authoring: phrase such items as "re-derive the inventory from `<ground-truth source>` and make the claim match the derived set," and when the ground-truth set is small enough, enumerate it in the hold item — the implementer then has the target in hand instead of reasoning from the faulty sentence.

## Why This Matters

A universal claim is all-or-nothing: "only these things" is false if there is one more thing, no matter how many patch rounds raised the stated count. Each delta-verified round also trains both sides to scan for the named element, confirm it, and proceed — the residual becomes progressively more invisible while the sentence reads as progressively more authoritative. For carve-out headers the cost is concrete: readers of auth-focused suites use the stated inventory to judge which behaviors run against real infrastructure and which sit behind stubs; an under-enumerated inventory misrepresents exactly that boundary, and the clause (a) documentation contract is defeated by the header it mandates.

## When to Apply

- Any edit to a comment containing "only X are mocked", "all N sites", "every caller", "none of the middleware", or "exactly N handlers".
- Implementing a hold item that flags an inventory omission — the fix target is set equality, not the named element.
- Reviewing such a fix — re-enumerate the ground truth yourself before approving the claim.
- Writing hold items about inventory sentences — prescribe re-derivation and enumerate the target set when known.

## Examples

Incremental patch (stays false — adds the named seams, never re-checks the rest of the file):

```text
// Only the database pools and the broadcast seams (broadcast.json,
// broadcastJsonWithTimeout, broadcastAdminCustomJson) are mocked.
```

Re-derived rewrite (produced by enumerating every factory first):

```text
// Mocked: the database pools; the hive.js factory (the broadcast seams
// broadcast.json / broadcastJsonWithTimeout / broadcastAdminCustomJson, all
// routed through one mock, plus a getAccounts -> [] read stub); and
// accreditation.js getAccreditedSet, stubbed to an empty accredited set.
// verifyHiveSignature is wrapped, not replaced: the real middleware runs
// unless a test sets the failure token.
```

The rewrite names every factory and characterizes the wrapper honestly. When the file gains a sixth factory, the next editor repeats the enumeration; the sentence is never extended by splicing.

## Related

- [[convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17]] — the complementary audit: that doc catches violations a fix introduces in its own ADDED text; this one catches falseness surviving in the UNCHANGED remainder of an edited universal claim. Run both when a fix adds code and edits prose.
- [[comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20]] — direction-complementary sibling: added clauses must be verified against the code; this doc adds that the surviving set-membership claim must be re-derived, not trusted.
- [[coverage-claim-downgrade-requires-codebase-search-2026-05-21]] — same root failure (minimal edit, skipped landscape verification) on coverage claims; this doc is the set-membership analogue.
- [[wrapping-primitive-exhaustive-call-site-audit-2026-04-22]] — "all X are wrapped" acceptance claims require grep, never mental enumeration; the same discipline applied to acceptance rather than comments.
- [[enumerated-exemption-lists-are-drift-vectors-2026-04-28]] — meta-principle ancestor: any complete-set claim must be mechanically derivable; this doc is the file-local comment-scope instance.
- [[test-mock-carve-out-clause-c-2026-05-04]] — the carve-out framework whose clause (a) headers carry these inventories and require them to be truthful.
- [[hold-block-must-not-contradict-convention-docs-2026-04-22]] — hold items prescribing inventory fixes must use the re-derive phrasing, not "add the missing element."

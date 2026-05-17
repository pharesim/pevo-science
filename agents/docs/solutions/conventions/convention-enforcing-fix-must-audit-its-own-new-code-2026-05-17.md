---
title: Convention-enforcing fix must audit its own new code, not just the cited sweep sites
date: 2026-05-17
category: conventions
module: agents/docs/solutions + code-review workflow
problem_type: convention
component: code-review
severity: medium
applies_when:
  - Reviewing a "purge X" / "anti-pattern enforcement" / "convention cleanup" round-N hold-fix
  - The fix adds new code (new tests, new helpers, new branches) alongside the cited sweep sites
  - Verifying that a comment-hygiene / dead-code / fictional-state / deprecated-flag purge landed cleanly
  - A hold item names N specific sites to fix and the implementer's signal block claims "grep returns zero"
tags: [code-review, convention-enforcement, comment-rot, reviewer-checklist, self-violation, fix-cycle, hold-block]
---

# Convention-enforcing fix must audit its own new code, not just the cited sweep sites

## Context

PEvO's hold-cycle workflow frequently produces "purge X" round-N items — `purge round-N citations`, `strip task-slug references`, `remove WHAT-commentary`, `delete the dead defended state`. The hold block names N specific sites; the implementer purges them; the architect verifies they're gone.

The recurring failure mode: the same fix commit that purges the N cited sites ADDS new code (new test files, new canaries, new helpers) that REINTRODUCES violations of the same convention. The implementer's grep-zero claim at their commit SHA is honest — they grepped the cited sites, found them clean. But the grep didn't look at the NEW files/code the same commit added.

Concrete incident (round-3 re-review of `backend-multi-author-cumulative-union`, 2026-05-17): round-2 item 4 purged 6 round-number citations across production + test code per the convention at [[task-slug-citations-in-comments-go-stale-on-archive-2026-05-15]]. The fix commits CORRECTLY purged the 6 cited sites AND THEN introduced two new round-N citations in their own newly-added test code:

- `backend/tests/lib/accreditation-orcid-cache.test.ts:4` (NEW file): header opened with `Background (round-2 hold item 2):`
- `backend/tests/routes/continuation-author-gate.test.ts:916` (NEW canary block): inline `// Item 1 (round-2 hold):` above the new test

The fix violated the same convention it was enforcing. Only the `ce-maintainability-reviewer` persona caught it at round-3 — and only because that persona's audit pattern inspects new files/code added by the fix, not just the sweep sites.

## Guidance

When reviewing a "purge X" / "anti-pattern enforcement" round-N fix, the reviewer checklist is TWO items, not one:

1. **Sweep audit (the obvious check):** Verify each cited sweep site is clean. Grep the file paths the hold item listed.
2. **Self-violation audit (the easily missed check):** Inspect every file the fix commit ADDED or substantially modified. Apply the same convention to that new code. Did the fix add new instances of the very thing it was purging?

Both checks must pass before the convention enforcement is complete. Either one passing alone leaves the convention violated.

The implementer-side mirror: when writing the fix, after purging the cited sites, re-grep the diff's own added lines for the pattern being purged. If you find a hit, you've reintroduced the violation; rewrite the new code with the convention's preferred shape.

## Why This Matters

- **The grep-zero-at-MY-SHA claim is honest but incomplete.** Implementers diff their fix against the cited sites; they don't naturally diff their fix against their own new code. Architects review at HEAD, where the new code is visible — but only if the reviewer's audit pattern looks for it.
- **Convention enforcement is metadata-attaching-reflex-prone.** When the implementer writes "this fix closes round-2 hold item N" thinking it'll help future archeology, the metadata-attaching reflex overrides the convention text that says "don't write round-N markers in code." The same reflex fires for `// TODO: remove this after the X task lands`, `// added for the Y migration`, `// see <slug>.md`. The convention text doesn't compete well with the impulse to label work.
- **Cross-rounds the bug recurs.** This is the second observed instance on PEvO comment-hygiene work in two months (the first was an earlier instance of the same pattern on a separate cluster's hold). Without a reviewer-checklist convention naming the gap, each new "purge X" task re-discovers the gap at round-N+1.
- **Cross-reviewer fan-out IS the documented mitigation, but it's tier-2.** The `ce-code-review` skill's persona fan-out (`maintainability`, `kieran-typescript`, `correctness`) is the structural backstop that catches self-violation when no individual reviewer's instinct does. Documenting the gap explicitly lets ANY reviewer (including a non-fan-out review pass like `/review` or a manual architect pass) catch it without depending on the fan-out coverage.

## When to Apply

- Reviewing ANY round-N hold-fix whose hold items include words like `purge`, `strip`, `remove`, `drop`, `delete`, `replace with permanent X`, `convergence to canonical Y`.
- Reviewing a fix that purges:
  - Task-slug citations (the canonical instance — see [[task-slug-citations-in-comments-go-stale-on-archive-2026-05-15]]).
  - Round-N markers (`round-3`, `round-6`, `Item 1`).
  - WHAT-commentary (per PEvO CLAUDE.md "Don't explain WHAT the code does").
  - "Current task / fix / callers" comments (per PEvO CLAUDE.md "Don't reference the current task, fix, or callers").
  - Deprecated flags or transitional shims.
  - Fictional-state defenses (per account-state-defense-review rule in PEvO CLAUDE.md § "Code Review Findings").
  - Dead exports / unused parameters / vestigial scaffolding.
- ALSO apply when the cited sweep is small (1-3 sites) but the fix commit's net diff is large (new test file, new helper module, new audit-event payload). Small-cited-sites + large-net-diff is the highest-risk shape because the implementer's mental model is "this is a small fix" while the new code surface is actually substantial.

## Examples

### Task-slug citation purge (the round-3 incident)

**Hold item:** Purge 6 round-number citations at papers.ts:208/:923/:1022/:1062/:2350 + continuation-author-gate.test.ts:981.

**Implementer fix:** Purged the 6 cited sites correctly. Also added a new test file `accreditation-orcid-cache.test.ts` with a header `Background (round-2 hold item 2):` and a new canary block in `continuation-author-gate.test.ts:916` with inline `// Item 1 (round-2 hold):`.

**Sweep audit:** ✓ The 6 cited sites are clean.
**Self-violation audit:** ✗ Two new round-N citations in the fix's own new code.

**Verdict:** Hold for round-3 with the two new sites added to the next sweep.

### Hypothetical: WHAT-commentary purge

**Hold item:** Strip the WHAT-commentary at `routes/foo.ts:120` (`// Loop through items and check status`).

**Implementer fix:** Removes the cited comment. Adds a new helper `function checkAllItems(items)` with a JSDoc `/** Iterates through items and returns the status of each one. */`.

**Sweep audit:** ✓ Cited site is clean.
**Self-violation audit:** ✗ The new JSDoc IS WHAT-commentary. The function name `checkAllItems` + return type already say what the JSDoc says.

**Verdict:** Hold with the new JSDoc added to the sweep.

### Hypothetical: deprecated-flag purge

**Hold item:** Remove the `legacyAuth: true` flag and all 3 call sites.

**Implementer fix:** Removes the flag and its 3 call sites. Adds a new `transitionalAuth: true` flag at one new call site "to ease the migration."

**Sweep audit:** ✓ `legacyAuth` is gone.
**Self-violation audit:** ✗ `transitionalAuth` is the same shape; the convention is "no transitional flags," not "rename the transitional flag."

**Verdict:** Hold with the new flag flagged for removal.

## Related

- [[task-slug-citations-in-comments-go-stale-on-archive-2026-05-15]] — the canonical WRITE-side rule this REVIEW-side check enforces. The two docs are complementary: the WRITE rule tells implementers what not to write; this REVIEW check tells reviewers to verify the fix didn't violate the WRITE rule in its own new code.
- [[concurrent-agent-staging-sweep-2026-05-12]] — sibling reviewer-instinct convention covering a different class of fix-self-incurred violation (the wrong files getting swept into a commit).
- [[architect-hold-block-risk-class-separation-2026-05-07]] — adjacent convention on hold-block construction; informs the implementer's mental model for "what counts as in-scope for this hold."
- [[cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14]] — sibling reviewer-instinct convention requiring inspection of all surfaces, not just the cited one (different problem class but same "audit beyond the cited sites" structural lesson).

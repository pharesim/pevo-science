---
title: "Source-discipline canaries must assert at call-site granularity, not file granularity — an allowlisted file hides its own second offender"
date: 2026-08-26
category: conventions
module: backend/tests + code-review process
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Writing a standing source-scanning test that enforces an architectural or security invariant by grepping the tree"
  - "The canary needs an allowlist of licensed sites, or a skip list of files that legitimately contain the matched pattern"
  - "The invariant is 'only THESE places may do X' and X is a call, an import, or a column write"
  - "Reviewing a canary whose allowlist entries are file paths, directory names, or module names"
  - "A canary's docblock names a specific high-risk scenario and you want to confirm the assertion actually covers it"
related_components:
  - development_workflow
  - documentation
  - authentication
tags:
  - conventions
  - canary-tests
  - source-discipline
  - invariant-enforcement
  - allowlists
  - granularity
  - silently-disarmed-guards
  - mutation-resistance
---

# Source-discipline canaries must assert at call-site granularity

## Rule

When a standing source-scanning test enforces "only these places may do X", the unit
it asserts on must be the **narrowest identifiable site** (an enclosing function, a
route handler, an exported symbol), never a **container** (a file, a directory, a
module).

The moment an allowlist entry is a container, the canary can no longer distinguish
"the licensed occurrence" from "a second, different occurrence that happens to live in
the same container". A container that is already allowed absorbs new offenders
silently.

Detection granularity and assertion granularity are different things, and only the
second one is load-bearing. A regex can match precisely at call shape and the canary
can still be blind, because what gets compared to the allowlist is whatever you
collected, not whatever you matched.

## Why this fails silently

This is a guard that reads as working. The suite is green. The docblock is thoughtful.
The regex has planted-positive and planted-negative self-tests proving it is not
mangled. Every visible signal says the invariant is enforced.

The failure only appears when someone adds the second offender, and at that moment the
canary's entire purpose (catching exactly that) does not fire. Worse, the canary's
existence actively suppresses scrutiny: a reviewer who sees a named, well-documented
guard for an invariant reasonably assumes the invariant is mechanically covered and
does not re-derive the check by hand.

The sharpest form of the failure: a canary whose docblock explicitly names the
highest-risk scenario, while its assertion is one granularity level too coarse to see
that exact scenario. The prose and the assertion disagree, and the prose is what gets
read.

## How to recognize the pattern

Ask one question of any canary with an allowlist:

> Can a second, different offender live inside an already-allowed container?

If yes, the granularity is wrong. Three concrete smells:

1. **The collector and the matcher disagree.** The regex matches a call; the `Set` or
   array collects `file` / `rel` / `path`. Look at what is pushed, not what is tested.
2. **A high-risk site cannot be added to the forbidden list.** If the dangerous
   location lives inside a file that must be on the allowed list, the forbidden list
   structurally cannot cover it. That is a granularity problem wearing a list-membership
   costume.
3. **A skip-by-path exclusion.** `if (rel === SOME_FILE) continue;` removes the file
   from scanning entirely, which is strictly weaker than excluding by pattern. Excluding
   by pattern still scans the file and still catches a *different* offending shape in
   it; excluding by path does not.

Also check the walk itself: a non-recursive `readdirSync` over one directory silently
exempts every subdirectory and every sibling directory, which is the same class of
blindness applied to the file system instead of to the file.

## Fix shape

Collect the enclosing site, not the container. From each regex match, scan upward for
the nearest enclosing named function or route registration and assert on `file#symbol`
pairs:

```ts
// Wrong: a second mint inside an already-allowed file is invisible.
callers.add(rel);
expect([...callers].sort()).toEqual([...ALLOWED_MINT_FILES].sort());

// Right: the licensed SITE is named, so a sibling branch in the same file fails.
sites.add(`${rel}#${enclosingSymbolAbove(lines, i)}`);
expect([...sites].sort()).toEqual([...ALLOWED_MINT_SITES].sort());
```

Three supporting rules:

- **Walk recursively.** A directory scan that does not recurse is an implicit allowlist
  of every subdirectory.
- **Exclude by pattern, not by path.** Keep the definition site in the scan and let the
  matcher exclude it, so a different offending shape in that file is still caught.
- **Keep the planted self-tests, and extend them to the new granularity.** Assert that
  two occurrences in one file produce two entries. Without that, a refactor can quietly
  collapse the collector back to container granularity and the self-tests will not
  notice.

## Examples

### PEvO concrete instances

Three landed in a single commit, in two canaries written specifically to prevent silent
regressions.

**`backend/tests/eslint/no-session-proof-mint-outside-reauth-routes.test.ts`** enforces
ARCHITECTURE 6.5 invariant #9: only the two re-auth routes may mint a session-kind
fresh-auth proof. Detection is call-shaped, so imports and prose correctly do not match.
But the assertion collects a `Set` of relative file paths and compares it to an allowed
list containing `routes/orcid.ts`. Adding a mint inside `handleLogin` leaves that Set
unchanged and the canary stays green. `handleLogin` is the scenario the file's own
docblock singles out as most likely, on the grounds that it is a sibling branch of the
same OAuth callback dispatch as the licensed `handleSessionAuth` and so a mint there
looks like a consistency fix rather than a security regression. `routes/orcid.ts` cannot
be added to the forbidden list because it is on the allowed list. Independent
verification confirmed no other test in the suite caught it either, making this the sole
mechanical enforcement of that invariant.

The same file also skips its definition module by path before scanning, so a
window-minting helper added there under a different name is unscanned rather than
unmatched.

**`backend/tests/routes/session-proof-invalidation.test.ts`** enforces that every route
stamping the session-revocation column also sweeps outstanding session proofs. It walks
one routes directory non-recursively and, per file, asserts only that a sweep call
appears *somewhere* in that file. A file that already calls the sweep therefore passes
no matter how many revocation writers it grows, and any writer outside that one
directory is invisible.

### The generalized shape

Any invariant of the form "only these places may do X" where the canary answers "which
files contain X" instead of "which sites are X". Common hosts: privileged-helper call
audits, column-write audits, direct-client-construction bans, and
must-be-wrapped-by-helper rules.

## Why this matters

A canary is a claim that a class of regression is mechanically impossible. When its
granularity is wrong, the claim is false in exactly the case it was written for, and the
falseness is invisible to every routine signal. The cost is not the missing test; it is
the misplaced confidence that stops anyone from checking by hand.

## Cross-references

Related, and deliberately distinct:

- `conventions/enumerated-exemption-lists-are-drift-vectors-2026-04-28.md` — about a
  convention *document* hand-enumerating exempt call sites. Same drift instinct, but the
  artifact is prose; here the artifact is a test's own comparison unit.
- `conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — a canary
  missing an entire *layer*. Here every layer is pinned; the pin is just too coarse to
  see occurrences within a covered container.
- `conventions/static-sql-lint-rule-blind-to-extracted-fragments-2026-06-14.md` — a
  different blind-spot mechanism (an interpolation boundary) with the same
  silently-disarmed-guard outcome.
- `conventions/concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo-2026-05-19.md`
  — the sibling lesson for runtime assertions: outcome-only assertions can be blind to a
  dropped mutation, so sample structural state from inside the call. Same underlying
  theme, that an assertion's *shape* decides what it can detect.

- `conventions/fail-closed-does-not-transfer-from-set-equality-to-pairing-canaries-2026-08-31.md`
  — the next rung on this ladder. Once the collected unit is a call site rather than a
  container, a *pairing* assertion over those keys can still fail open: the resolver's
  module-scope fallback satisfies itself on both sides, which is file-granularity
  reasoning wearing a symbol-shaped key. Granularity correct, comparison shape unsound.

## Source

Surfaced by a `/ce-code-review` pass over the windowed session fresh-auth work, where
two reviewer personas and one independent validator converged on the first instance and
a learnings search across the whole solutions store confirmed the class was not yet
documented anywhere.

---
title: "A canary's fail-closed property does not survive a change of assertion shape — set-equality is safe against the module-scope fallback, pairing is not"
date: 2026-08-31
category: conventions
module: backend/tests/eslint + backend/tests/support/enclosing-symbol.ts
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Adding a source-discipline canary that asserts pairing (every occurrence of X must be accompanied by an occurrence of Y in the same enclosing symbol) rather than set-equality against an allowlist"
  - "Citing the enclosing-symbol resolver's module-scope fallback as fail-closed protection for a canary whose assertion shape differs from the one that property was verified against"
  - "Extending an existing set-equality canary into a pairing assertion, or adding a pairing assertion beside one"
  - "Reviewing a canary whose satisfying set is produced by another scan rather than by a fixed allowlist"
related_components:
  - development_workflow
  - authentication
tags:
  - conventions
  - canary-tests
  - source-discipline
  - fail-closed
  - enclosing-symbol
  - mutation-testing
---

# A canary's fail-closed property does not survive a change of assertion shape

## Context

PEvO's source-discipline canaries under `backend/tests/eslint/` scan `backend/src`, resolve
each regex match to a `file#symbol` key through `occurrencesOf` / `enclosingSymbol` in
`backend/tests/support/enclosing-symbol.ts`, and assert over the resulting keys. When a
match sits outside any recognized declaration, the resolver returns the `MODULE_SCOPE`
constant, producing a key like `routes/foo.ts#<module>`.

Two assertion shapes are built on that same machinery, and only one of them inherits the
resolver's fail-closed property.

**Set-equality** compares the key set against a fixed allowlist of named sites. A
`#<module>` key can never equal a named handler, so an unresolvable occurrence is a red
bar. This is genuinely fail-closed, and the canary that uses it pins the property
explicitly rather than assuming it.

**Pairing** asserts that every occurrence of X is accompanied by an occurrence of Y under
the same key, by filtering one scan's keys against a set built from another scan:

```js
const consumes = occurrencesOf(sources, CONSUME_CALL_RE, ...);
const epochs = new Set(occurrencesOf(sources, EPOCH_REF_RE, isCommentLine).keys);
const offenders = consumes.keys.filter((key) => !epochs.has(key));
```

Here the satisfying set is not a fixed external list. It is whatever the other side's scan
produced, including its own module-scope keys. If a demand-side occurrence and an unrelated
supply-side occurrence both sit outside a declaration in the same file, both resolve to
`file.ts#<module>` and satisfy each other. The bar stays green while the invariant is
violated.

The property was verified once, against the set-equality shape, and then inherited by
assumption when pairing canaries were added later. A grep for the constant shows the
asymmetry directly: only the set-equality canary references `MODULE_SCOPE` at all; neither
pairing canary imports it or guards against it.

The support module's own docblock states the fail-closed argument as a property of the
resolver rather than of one assertion shape, so it hands the false invariant to the next
author who builds on it. Its reasoning ("a wrong symbol is a new member of the occurrence
set and therefore a red bar, never a silent pass") is airtight for a fixed allowlist and
does not hold when the comparison set is another scan's output.

Not currently exercised: every real occurrence in the tree today resolves inside a named
function or route handler, so no live false pass exists. This is a latent property of the
harness, and nothing prevents a module-scope occurrence from landing tomorrow.

## Guidance

When a canary's assertion shape changes from allowlist membership to pairing, re-derive
the fail-closed argument from scratch. Do not inherit it from a sibling canary that shares
the resolver.

In every pairing assertion, filter module-scope keys out of the satisfying set, and make an
unresolved demand-side occurrence an offender in its own right rather than something that
can be paired away:

```js
const isModuleScope = (key) => key.endsWith(`#${MODULE_SCOPE}`);
const epochs = new Set(
  occurrencesOf(sources, EPOCH_REF_RE, isCommentLine).keys.filter((k) => !isModuleScope(k)),
);
const offenders = consumes.keys.filter((key) => isModuleScope(key) || !epochs.has(key));
```

That restores the forcing function set-equality gets for free: an occurrence the resolver
cannot place must be moved inside a named symbol or explicitly justified, rather than
silently satisfied by an unrelated neighbour.

Then scope the resolver's docblock claim to the shape it actually holds for. A claim
written as a property of the shared module will be read as covering every canary built on
it.

## Why This Matters

These canaries enforce security invariants: which routes may mint a session proof, and
that a revocation epoch accompanies every consume. The whole point of resolving to
`file#symbol` instead of to a file was to stop a second, unrelated occurrence in an
already-covered container from hiding behind the first.

An unguarded pairing assertion reintroduces exactly that blind spot for the module-scope
case. Two unrelated occurrences pair because they share a container, which is
file-granularity reasoning wearing a symbol-shaped key. The regression lands inside the
suite written specifically to eliminate it, and it is invisible precisely because the
resolver is documented as safe.

The general form: promoting a coarse "did this container match" check to a fine "did this
symbol match" check requires a synthetic bucket for everything the resolver cannot place.
That bucket is harmless under set-equality and load-bearing under pairing.

## When to Apply

Before trusting an existing self-test or docblock to cover a new canary, ask which shape it
uses:

- **Set-equality or allowlist membership** (`toEqual(ALLOWED)`): the module-scope bucket is
  safe by construction, no extra handling needed.
- **Pairing or co-occurrence** (`X.keys.filter(k => !Y.has(k))`, or any "every A needs a
  matching B"): the bucket must be excluded from the satisfying set and asserted against
  directly on the demand side.

Applies to any static-analysis harness that resolves matches to a scope key and has a
fallback bucket for unplaceable matches, not only to this repo's canaries.

## Examples

A file whose two statements both sit at module scope, with a genuinely missing epoch:

```js
// both statements at top level, no enclosing declaration
void consumeSessionFreshAuthToken(cachedToken, cachedUser, undefined); // epoch omitted
type Debug = { hiveSessionsInvalidatedAt: number };                    // unrelated mention
```

Both resolve to `#<module>` in the same file, so the epoch mention satisfies the consume's
pairing requirement and the suite is green on a real violation. Under the guarded form
above, the consume is an offender because its own key is module-scope, and no amount of
unrelated neighbours can pair it away.

## Related

- `conventions/source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md`
  — the prerequisite on the same ladder. That entry fixes *what unit* gets collected; this
  one is about whether the *comparison shape* preserves the resolver's safety once the unit
  is correct. A canary can be perfectly call-site granular and still fail open under
  pairing, so fixing granularity is necessary and not sufficient.
- `conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — a canary missing
  a whole layer. Here every layer is pinned and the comparison between them is unsound.
- `conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the parent
  principle. A pairing canary revert-verified against "add an unplaceable occurrence" would
  have shown this immediately.
- `conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — the
  same error one level up: a kill claim carried over by analogy instead of re-verified
  against the assertion that now has to catch it.

A separate, deliberately accepted limitation of the same pairing scans, not covered here:
pairing is by enclosing symbol rather than by control flow, so a write on an early-return
branch of a handler that pairs further down still counts as paired.

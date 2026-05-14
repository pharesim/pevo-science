---
module: hold-cycle
date: "2026-05-14"
problem_type: convention
component: development_workflow
severity: high
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
applies_when:
  - "An architect hold block asks the implementer to add behavioral-matrix or per-shape test coverage against a shape-discriminating guard (jsonb_typeof, isString, instanceof, regex variant test, runtime type guard)"
  - "The defended failure mode is 'the field can be many things and the wrong shape bypasses the guard'"
  - "The hold-block recipe lists a finite set of shapes to test (e.g., null/string/number/object)"
  - "Architect intake reviews a multi-round task where the prior round's shape-coverage hold landed"
symptoms:
  - "Implementer's disposition table marks the shape-coverage hold item as Fixed; behavioral matrix lists the architect's enumerated shapes"
  - "Re-review /ce-code-review fan-out adversarial reviewer constructs a bypass at a shape NOT listed in the original hold and verifies it at real infrastructure (psql, runtime)"
  - "The shape that bypasses lies on an axis the architect's enumeration didn't traverse (e.g., array element type when only top-level type was enumerated; object key presence when only object-vs-not was enumerated)"
  - "Implementer's defense ('existing matrix exercises through the same path') is structurally correct for the listed shapes but doesn't catch the missed axis"
tags:
  - "shape-coverage"
  - "hold-cycle"
  - "architect-protocol"
  - "behavioral-matrix"
  - "test-coverage"
  - "jsonb"
  - "type-guard"
  - "shape-discriminator"
  - "enumeration-completeness"
---

# Hold-block shape coverage must walk the full lattice, not just one axis

## Context

When PEvO's architect hold-block asks for behavioral-matrix coverage against a shape-discriminating guard, the architect typically enumerates *shapes* the test must cover. The recurring failure mode: the enumeration walks one axis of a multi-axis shape lattice and silently misses the others. The test ships covering what was listed; the bypass exists at a shape not on the list; the next /ce-code-review round discovers it adversarially.

Concrete case (round-1 → round-2 of `backend-self-review-exclusion-everywhere`, 2026-05-13 → 2026-05-14): the architect held the implementer to add a `jsonb_typeof(...) = 'array'` guard at `excludeSelfReviewWhere` in `backend/src/hafsql.ts`. The recipe enumerated 4 *top-level* JSONB shapes to test as values for `pevo.authors`: null-literal, string, integer, object. The implementer landed the guard. The architect's round-2 review (parallel /ce-code-review pass) constructed and verified at real Postgres that the guard still over-admits when `pevo.authors` is an **array of non-objects**: `["alice","bob"]` (strings), `[null]`, `[1,2,3]`, `[{"name":"alice"}]` (object missing the `hive` key). The architect's enumeration covered top-level type but missed nested element type and key presence.

The bypass: `jsonb_typeof('array')` returns `'array'` for an array of strings (correct), so the CASE THEN branch fires. `jsonb_array_elements` yields JSONB strings. On a JSONB string, `auth ->> 'hive'` returns NULL (`->>` only extracts object keys). `NULL = c.author` is NULL, not TRUE → the EXISTS subquery returns 0 rows → NOT EXISTS evaluates TRUE for every reviewer → the helper admits every named-string co-author as a non-self reviewer.

## Guidance

When holding "enumerate the shapes that need behavioral-matrix coverage" against any shape-discriminating guard, walk the **full lattice**, not just one axis.

For each defended field, identify every shape axis the guard might miss:

- **JSONB / JSON values**: top-level type (`null` / string / number / boolean / array / object / missing-key) × within-array element type (string / number / null / object / nested array) × within-object key presence (missing key / null value / wrong key name)
- **TypeScript runtime types**: `typeof === 'object'` further splits into null / array / plain-object / class-instance; `typeof === 'number'` further splits into integer / float / NaN / Infinity
- **HTTP request bodies**: top-level shape (missing / null / array / scalar / object) × per-field shape × required-vs-optional × extra-fields-allowed-vs-strict × duplicate-key handling
- **Hive custom_json payloads**: action enum × required-vs-optional fields × shape-of-nested-fields × extra-fields (any accredited account can broadcast attacker-controlled metadata)

Enumerate one row per leaf of the lattice that the discriminator's predicate can encounter. The hold-block recipe should name each row explicitly so the implementer's `applies_when`-style mental check is exhaustive at hold-fix time, not discovery-driven at re-review time.

## Why This Matters

Shape-discriminator bugs in load-bearing guards are by design **silent**: the test suite passes (covers what was listed), the guard ships, the predicate compiles and runs without exceptions, the bypass exists only for shapes outside the test enumeration. The only detection paths are adversarial review (constructing the bypass against real infrastructure) and production exploitation.

The specific case at hand widened `excludeSelfReviewWhere`'s blast radius via the round-1 commit's 10-callsite propagation. The bypass at one site (named co-author writes self-review with `pevo.authors=["alice","bob"]`) cascades to all 10 callsites including the reputation cycle's three review-class CTEs and the four display surfaces. A single accredited account broadcasting a paper with a non-object-array authors field would enable named-string co-authors to self-vouch via reviews and inflate paper quality scores. Discovered at round-2 review because the adversarial persona constructed the scenario at real Postgres; not discovered at round-1 because the behavioral matrix only covered top-level shapes.

The cost asymmetry: enumerating the full lattice at hold-block authorship time adds ~5 minutes per held item. Discovering a missed axis at re-review costs a full /ce-code-review fan-out (10+ subagents) plus a re-hold cycle plus the implementer's re-implementation. The hold-block author bears the cost-cheap side of the asymmetry; deferring shape enumeration to "the implementer will figure it out" or "the existing matrix covers" pays the cost-expensive side every time.

## When to Apply

- Holding any test-coverage scope against a JSONB / JSON shape discriminator (`jsonb_typeof`, `->>` on potentially-non-object values, `?` operator)
- Holding any TypeScript test-coverage scope against a runtime type guard (`typeof`, `instanceof`, `Array.isArray`, custom `isFoo(x)` predicates)
- Holding any test-coverage scope against an HTTP-body validator or zod schema where the threat model is "the caller can send arbitrary shapes"
- Holding any test-coverage scope against a Hive custom_json payload validator where the threat model is "any accredited account can broadcast"
- More generally: any predicate of the form "the value at this path can be many things, and the wrong shape changes admit/reject behavior"

Skip this discipline when the field has a strict producer contract (e.g., a typed enum coming from a typed module surface that has its own static guarantees) AND the consumer trusts the producer per a documented invariant. In those cases the threat model doesn't include hostile shape construction. PEvO's chain-broadcast paths are the opposite: every field is attacker-influenced and the threat model assumes hostile shape construction.

## Examples

### Anti-pattern (the round-1 hold that missed the axis)

```
**Hold item: add jsonb_typeof guard at excludeSelfReviewWhere**

Fix: wrap the jsonb_array_elements argument in
  CASE WHEN jsonb_typeof(p.json_metadata -> $tag -> 'authors') = 'array'
       THEN p.json_metadata -> $tag -> 'authors'
       ELSE '[]'::jsonb END

Add a behavioral-matrix row in hafsql.test.ts for each of the four
non-array shapes (null-literal, string, integer, object) to pin
that the guard short-circuits without throwing.
```

The enumeration walks one axis: top-level JSONB type. It misses the array-element axis. The shape `["alice","bob"]` is an array (passes the top-level guard) but contains non-object elements (bypasses the inner `auth ->> 'hive'` check).

### Pattern (the round-2 hold that walks the full lattice)

```
**Hold item: tighten excludeSelfReviewWhere to require object-typed elements**

Fix: change the EXISTS subquery to require:
  WHERE jsonb_typeof(auth) = 'object'
    AND auth ->> 'hive' = c.author

Add behavioral-matrix rows in hafsql.test.ts covering:

  Top-level shapes (no Postgres exception, admit-row matches empty-array case):
    - authors: null
    - authors: "alice"
    - authors: 42
    - authors: {hive: "bob"}
    - (missing authors key entirely)
    - authors: [] (empty array — baseline)

  Array-of-non-objects shapes (named-string co-author NOT admitted as non-self):
    - authors: ["alice","bob"]
    - authors: [null]
    - authors: [1,2,3]
    - authors: [{name: "alice"}]   (object missing 'hive' key)
    - authors: [{hive: null}]      (object with null at the discriminating key)

  Mixed (valid object + invalid sibling):
    - authors: [{hive: "alice"}, "bob"]
    - authors: [{hive: "alice"}, {name: "bob"}]
```

The full lattice. Each row is a leaf the discriminator can encounter; each is named explicitly so neither the implementer nor the re-review fan-out has to discover it.

### Generalized (TypeScript runtime type guard)

```
**Hold item: add type guard at <site>**

Fix: narrow before use:
  if (typeof x !== 'object' || x === null) return null;
  if (Array.isArray(x)) return null;
  // x is now narrowed to plain object
  if (typeof x.id !== 'string') return null;

Add unit-test rows covering:

  typeof variants:
    - x = null              (typeof 'object')
    - x = undefined         (typeof 'undefined')
    - x = "abc"             (typeof 'string')
    - x = 42                (typeof 'number')
    - x = false             (typeof 'boolean')

  typeof === 'object' refinement:
    - x = []                (Array)
    - x = new Date()        (class instance)
    - x = {}                (plain object, no id)
    - x = { id: null }      (object with null id)
    - x = { id: 42 }        (object with non-string id)
    - x = { id: "valid" }   (happy path)
```

## Related

- `agents/docs/solutions/conventions/pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md` — the original `jsonb_typeof = 'array'` guard convention that this entry corrects. The earlier convention prescribed the top-level-type guard correctly; this entry adds the missing requirement to enumerate element-type and key-presence axes.
- `agents/docs/solutions/conventions/hold-item-completion-structural-vs-behavioral-2026-05-12.md` — sibling convention on hold-item resolution discipline; covers the structural-vs-behavioral axis at the call-site consumer level. This entry covers the test-enumeration completeness axis at the hold-block-authorship level.
- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — sibling pattern on canary completeness: each defensive layer needs its own canary. This entry is the analog for shape coverage at a single layer: each shape axis needs its own test row.
- `agents/docs/solutions/conventions/object-shape-fix-every-reset-site-2026-04-21.md` — sibling on completeness discipline: when fixing an object shape, fix at every reset site, not just the one that triggered the discovery.
- `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` — sibling entry, same date, same family of "hold-block authorship enumeration completeness." This entry covers shape-coverage axes within a single guard; that entry covers composition-site enumeration across sibling guards.

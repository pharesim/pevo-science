---
title: "Positional anchors (`above`, `below`) are durable when the cited sibling shares a stable named container"
date: 2026-05-20
category: conventions
module: agents/docs/solutions/conventions
problem_type: convention
component: documentation
severity: medium
applies_when:
  - "Writing a comment in code or tests that cites a nearby sibling (`the X canary above`, `the Y helper below`, `the Z it-block above`)"
  - "Reviewing such a comment under `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`'s self-audit rule"
  - "Triaging a `/ce-code-review` finding that flags an `above`/`below` reference as anchor-rot"
  - "Authoring an architect hold-block that prescribes preserving (or rewriting) a positional anchor"
tags:
  - comment-anchor
  - positional-anchor
  - convention-refinement
  - reviewer-calibration
  - rot-class-carve-out
---

# Positional anchors (`above`, `below`) are durable when the cited sibling shares a stable named container

## Context

PEvO's comment-anchor convention cluster (root `CLAUDE.md` § "Comment anchors" plus several solutions-conventions docs) enumerates positional anchors — `above`, `below`, `next test`, `previous test`, `the spec just above` — as a rot class to be caught by every self-audit alongside task slugs, round numbers, line numbers, and SHAs. The rule as written has caused `/ce-code-review` reviewers (project-standards, learnings-researcher, occasionally correctness) to flag legitimate sibling references three times across separate sessions:

1. `backend-comment-anchor-rot-sweep-accreditation-ts` round-4 — architect-prescribed `above` references preserved per the hold block's explicit carve-out language ("anchors on a stable sibling-canary behavioral relationship, not on coordination state").
2. `backend-haf-outage-translation-audit-across-routes` round-4 review (2026-05-20) — finding flagged the preserved `the 42601 canary above` in the 57P03 canary's it-block comment; architect dismissed per the prior round-3→round-4 prescription.
3. `backend-isretriable-haf-add-57p01-and-53300-coverage` round-1 review (2026-05-20) — cross-corroborated project-standards (75) + correctness (40) finding flagged a NEW `the 57P03 canary above` in the 57P01 canary's comment; architect dismissed per the same rationale.

The pattern recurs because reviewers correctly grep for `above`/`below` per the self-audit rule, but the rule as written doesn't carve out the legitimate case where the cited sibling shares a stable named container (a describe block, a function body, an enumerated section). Each occurrence burns architect cycles on the same dismissal. This entry codifies the carve-out so reviewers calibrate down, implementers know when the anchor is durable, and the architect stops re-explaining the same rationale.

## Guidance

**Positional anchors within a STABLE NAMED CONTAINER are durable.** A `the X above` / `the Y below` reference is rot-prone when the cited sibling could be displaced by an insertion in between. It is DURABLE — and the self-audit rule should NOT flag it — when ALL THREE of the following hold:

1. **Same named container.** The cited sibling lives in the SAME explicitly-named container as the citing comment — same `describe` block in tests, same function body in code, same enumerated `## section` heading in docs, same docblock paragraph. Crossing a container boundary is rot; staying within one is not.
2. **Stable name companion.** The cited sibling is referenced by a stable behavioral name alongside the position: `the 42601 canary above` (SQLSTATE code = stable name), `the helper above` does NOT qualify (only positional flavor).
3. **Insertion preserves meaning.** Adding a sibling between the two does not invalidate the citation. With the stable-name companion the citation still resolves correctly: "the 42601 canary above" still points at the 42601-keyed canary even if other canaries land between them.

The rot risk is REAL when ANY criterion fails. Self-audit grep for `above`/`below` should look for:

- Citations that cross container boundaries (different describe blocks, different functions, different sections).
- Citations using only positional information with no stable companion name (`the previous spec`, `the function above`, `the helper below`).
- Citations where loose descriptors could become ambiguous after an insertion (`the canary above` when multiple canaries match the loose descriptor).

## Why This Matters

Without the carve-out, the same triage cycle plays out repeatedly:

- Reviewer grep finds `above` / `below`, flags as rot.
- Architect reads the comment in context, recognizes the cited sibling is in the same describe block + named by a stable identifier, dismisses.
- The dismissal lives in the task hold block, which archives away. Next session, the same finding fires.

This is the precise feedback loop `/ce-compound` exists to close. The carve-out is not a relaxation of the convention — the underlying enumeration of `above`/`below` as a default rot class is correct as a starting point. This entry refines the criterion so:

- Reviewers know to first check the container + stable-name conditions before flagging.
- Implementers writing new tests know they can cite `the X canary above` confidently when X is SQLSTATE-named (or otherwise stably named) and lives in the same describe block.
- Architect hold-block prescriptions don't have to re-explain the rationale on every recurrence.

The existing `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` doc remains valid — the broad enumeration is correct as a default. This entry adds the precision the broader doc lacks.

## When to Apply

- When writing a new test or code comment that references a nearby sibling. If the sibling shares a describe block / function body / enumerated section AND has a stable name (SQLSTATE code, function name, route path, exported symbol, enum value), `the X above` is fine.
- When reviewing such a comment under `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`'s self-audit rule. Check the three criteria before flagging.
- When triaging a `/ce-code-review` finding that flagged a positional anchor. If all three criteria hold, dismiss. If any fails, the rot risk is real.
- When writing an architect hold block that touches a positional anchor. Prescribe per the criteria; do not re-litigate the default enumeration.

## Examples

**Durable (do NOT flag):**

```typescript
// In backend/tests/routes/haf-outage-translation-canaries.test.ts,
// inside describe('HafQueryError with deterministic pg error code → 500'):
it('cannot_connect_now (57P03) ... 503 retriable', async () => {
  // Pins `isRetriableHafError`'s 57P03 classification ... as retriable.
  // The mirror-shape of the 42601 canary above ensures the discriminator
  // distinguishes deterministic-pg from transient-pg on exactly the same call path.
  ...
});
```

Durable because: (1) the 42601 canary is in the same describe block; (2) "42601 canary" is named by the SQLSTATE code (stable); (3) inserting other canaries between them still leaves the 42601-keyed canary identifiable by its SQLSTATE name.

```typescript
// In the same describe block as the 57P03 canary above:
it('admin_shutdown (57P01) ... 503 retriable', async () => {
  // Pairs with the 57P03 canary above as the two halves of the Postgres
  // restart cycle: shutdown (57P01) and startup (57P03).
  ...
});
```

Durable because the same three criteria hold; "57P03 canary" is the stable name companion.

**Rot risk (DO flag and rewrite):**

```typescript
function fetchUserPapers(...) {
  // Mirrors the helper above for fetching reviews.
  ...
}
```

Rot risk because: "the helper above" is purely positional with no stable name. Insertion of another helper between the two breaks the citation's meaning.

```typescript
// In a single-spec file:
it('returns 200 on success', async () => {
  // As discussed in the section above, ...
});
```

Rot risk because: "the section above" crosses out of the current `it` block, has no stable section name, and depends on file-level positioning.

```typescript
it('canary X', async () => {
  // See the canary above for the matched-shape test.
  ...
});
```

Rot risk because: "the canary above" is loose. If the file gains additional canaries above this one, the citation becomes ambiguous about which "canary above" is intended.

## Related

- [[convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17]] — the broader self-audit rule this entry refines. The default enumeration of positional anchors as rot is correct as written; this entry adds the named-container carve-out.
- [[docblock-anchor-stable-symbols-not-line-numbers-2026-05-15]] — base anchor-stability convention establishing that stable symbols (function names, exported identifiers, SQLSTATE codes, route paths) are the durable anchor shape. The stable-name companion criterion in this entry leans directly on that doc's definition of "stable."
- [[task-slug-citations-in-comments-go-stale-on-archive-2026-05-15]] — sibling rot-class convention covering task slugs (a stricter rot class with no carve-out — task slugs always rot on archive).
- [[comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20]] — convention sibling on the same self-audit lens. A comment sweep that introduces a positional anchor still needs the behavioral-accuracy audit on the surrounding clause.
- Root `CLAUDE.md` § "Comment anchors" — the project-wide policy this entry refines without superseding.

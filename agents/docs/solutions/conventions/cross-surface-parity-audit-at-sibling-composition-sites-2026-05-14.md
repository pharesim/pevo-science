---
module: hold-cycle
date: "2026-05-14"
problem_type: convention
component: development_workflow
severity: high
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
applies_when:
  - "An architect hold-block or code review adds a gate / predicate / composition at one site within a sibling family (e.g., one CTE among several composing the same helper, one route among several mounting the same middleware, one render path among several materializing the same field)"
  - "The fix maintains an invariant the architect names explicitly (e.g., 'display↔reputation parity', 'admitted-set symmetry', 'auth-gate-on-write-and-on-read')"
  - "The architect appends an 'Items NOT in scope' or 'deferred for follow-up' note flagging some sibling sites but not all"
  - "Architect intake reviews a multi-round task where the prior round's gate-add landed"
symptoms:
  - "Re-review /ce-code-review fan-out P1 finding: the same invariant is broken at a sibling site in the same file or near-sibling file that the prior hold-block's 'Items NOT in scope' note didn't enumerate"
  - "The missed sibling is a direct peer (same function family, same predicate composition, same file) of an already-flagged site"
  - "The fix shape at the missed site is identical to the fix that just landed at the named sites"
  - "The architect's prior round flagged one sibling explicitly but missed a parallel sibling — the enumeration walked through 'related but different file' and stopped before 'related and same file'"
tags:
  - "cross-surface-audit"
  - "hold-cycle"
  - "architect-protocol"
  - "parity-invariant"
  - "sibling-composition"
  - "ce-code-review"
  - "scope-completeness"
  - "validReviewWhere"
  - "validPevoPaperWhere"
---

# Cross-surface parity audit: enumerate sibling composition sites in the same file before declaring an "Items NOT in scope" frontier

## Context

When an architect hold-block (or follow-up review) adds a gate, predicate, or composition at one site within a sibling family — and the fix maintains an explicitly-named invariant — the architect must audit **all sibling composition sites in the same file** before declaring an "Items NOT in scope" frontier. The recurring failure mode: the audit walks across files (e.g., notifications.ts, papers.ts) and across modules (e.g., reputation cycle vs display surfaces) but stops at "different surface, different round," missing direct peers in the same file or function family.

Concrete case (round-3 → round-4 of `backend-review-validity-gate-and-display-reputation-parity`, 2026-05-13 → 2026-05-14): round-3 lifted `validPevoPaperWhere` into `reputation.ts:user_reviews` CTE JOIN and `notifications-arm-sql-shape` arm 1a. The architect's round-3 hold-block "Items NOT in scope" note explicitly flagged the parallel asymmetry at `getProfileStats user_reviews CTE` at `profile.ts:92-100` (deferring it to a separate task). It missed the direct peer `fetchUserReviewsFromHaf` at `profile.ts:317` — same file, same predicate family, same display↔reputation parity invariant the task's slug literally names. The round-4 review (parallel /ce-code-review pass) discovered the missed peer as a P1 finding because adversarial constructed the bypass scenario (accredited reviewer writes pevo.review-shaped reply to non-paper Hive content; row surfaces on `/api/profile/alice/reviews` with `paper_title=''`).

The architect's enumeration walked:
- Across modules (reputation cycle → display): hit
- Across files (notifications.ts → papers.ts → profile.ts): hit
- Within profile.ts (getProfileStats → ...): flagged getProfileStats, missed fetchUserReviewsFromHaf — both functions in the same file, both querying the same comments-vs-reviews relation, both subject to the same parity invariant

The "within the same file, different function" axis is the cheapest to walk and the easiest to miss. The architect's mental model treated "getProfileStats" as the canonical example for "profile.ts has an un-gated user_reviews-style CTE" and stopped without enumerating profile.ts's other reviews-producing function.

## Guidance

When a hold-block or review adds a gate at one composition site within a sibling family, **before declaring an "Items NOT in scope" or "deferred follow-up" frontier**, run a structured cross-surface audit:

1. **Identify the gate's invariant.** Name it explicitly — what set must remain equal across surfaces? (e.g., "the set of reviews counted toward reputation MUST equal the set displayed on profile pages"; "every CTE composing `validReviewWhere` MUST also compose accreditation"; "every route that mounts middleware X MUST also mount middleware Y"). The invariant is the contract; sibling sites are anywhere the contract applies.

2. **Enumerate composition sites by widening rings.** Walk outward from the just-fixed site:
   - **Same function** (other branches, other CTEs in the same query, other code paths)
   - **Same file** (other functions querying the same data or composing the same predicate family)
   - **Same module** (sibling functions in the same component / route handler family)
   - **Sibling modules** (other routes that mount the same middleware; other workers that consume the same queue)
   - **Cross-cutting consumers** (anything downstream that depends on the just-modified contract)

   The "same file, different function" ring is the most-often-skipped one. Walk it explicitly.

3. **For each enumerated site, decide one of three explicit dispositions:**
   - **Fold into current hold** — include the fix at this site in the current round's hold-block. Cheapest; doesn't require a separate task or a re-review cycle.
   - **Architect-decided dismiss** — site is materially different and the invariant doesn't apply here. Document the reason inline so future reviewers don't re-flag it.
   - **Deferred follow-up** — track as a follow-up task or carry-forward. Name the site explicitly in the "Items NOT in scope" frontier so future architects can audit the frontier against new code.

   The disposition must be *explicit* and *enumerated*. "I didn't think about it" is not a disposition.

4. **Validate the frontier by inversion.** After listing "Items NOT in scope," re-read the list as: "I am claiming the following sites do NOT need the fix because <reason>." If any reason reduces to "I didn't enumerate them," that's the gap — go back to step 2 and widen.

## Why This Matters

Parity invariants are load-bearing claims in compound tasks: the task's slug, acceptance criteria, and architectural rationale ALL depend on the invariant holding *everywhere it applies*. A gate added at one site that the invariant names while a sibling site silently violates it produces:

1. **A false-positive sense of completion** — the task signals "ready for archive" because all explicitly-listed items are addressed.
2. **A re-review discovery cost** — the next /ce-code-review round burns a full fan-out + re-hold + re-implementation cycle to catch what the architect could have caught at hold-block authorship.
3. **A trust degradation in the invariant claim** — future readers see "display↔reputation parity" in a task's slug and don't know whether it actually holds at the surfaces they care about.
4. **A compounding risk** — each missed sibling site widens the threat surface for the failure mode the invariant was protecting against. In the case at hand, round-3 fixed `user_reviews` and `notifications arm 1a` but left `fetchUserReviewsFromHaf` un-gated; an accredited reviewer can spam `/api/profile/alice/reviews` with `pevo.review`-shaped replies to non-paper content and the row surfaces. Reputation correctly excludes; display admits — the exact asymmetry the task's slug names.

The cost asymmetry: walking the "same file, different function" ring adds ~5 minutes per hold-block — a grep for the predicate family in the file, a per-function quick scan, an explicit disposition for each match. Discovering the missed sibling at re-review costs a full /ce-code-review fan-out (10+ subagents) + re-hold cycle + re-implementation + the implementer's re-test pass.

The architect's "Items NOT in scope" note is doing useful work — naming follow-up surfaces. The improvement isn't to remove that pattern; it's to require the note to be the *result* of an explicit enumeration, not the *summary* of what came to mind.

## When to Apply

- Adding any predicate / gate / middleware composition where the architect names an invariant (parity, symmetry, every-X-must-have-Y)
- Closing any "this task is about <invariant>" task where the task slug or acceptance criteria explicitly claim the invariant
- Writing an "Items NOT in scope" or "deferred follow-up" note in a hold-block — the note itself is the trigger to run the audit
- Holding a multi-round task where prior rounds touched one site in a sibling family — the next round MUST audit the family before declaring scope

Skip the discipline when the just-added composition is structurally local (e.g., a single field rename with no semantic invariant attached, a logging-level adjustment, a comment-only change). The audit's value scales with the breadth of the invariant being claimed.

## Examples

### Anti-pattern (round-3 hold "Items NOT in scope" note that missed fetchUserReviewsFromHaf)

The round-3 hold-block of `backend-review-validity-gate-and-display-reputation-parity` ended with:

```
### Items NOT in scope (potential follow-ups, no scope-expansion this round)

- getProfileStats user_reviews CTE at profile.ts:92-100: also lacks an
  accreditation gate (would inflate review_count on the unaccredited
  user's profile stats panel). Not listed in the hold block; flagging
  for architect awareness so it can be ticketed as a separate task if
  desired. Symmetric in spirit with item 2 but on a different route
  (/profile/:username vs /profile/:username/reviews).
```

The note correctly flags `getProfileStats` (lines 92-100). But it doesn't enumerate `fetchUserReviewsFromHaf` (line 317) — the function that produces the `/api/profile/:username/reviews` route's data. Same file. Same predicate family. Same invariant. Missed because the architect's mental model walked "getProfileStats is profile.ts's example of un-gated user_reviews" and stopped.

The round-4 review discovered the missed peer as a P1 finding via adversarial scenario construction.

### Pattern (cross-surface audit applied to the same hold-block)

Before writing the "Items NOT in scope" frontier, an explicit enumeration:

```
### Cross-surface audit for the validPevoPaperWhere parent-paper gate

Invariant: every CTE/query that JOINs `reviews` → `parent paper` to
materialize a reviews universe MUST compose `validPevoPaperWhere(p, source='all')`
on the parent JOIN, OR explicitly document why the surface doesn't need it.

Composition sites within the predicate family:

- reputation.ts:user_reviews CTE (line 666):
    FOLD INTO ROUND-3 — gate added via cross-task lift-in
- reputation.ts:paper_reviews CTE (line ~590):
    DISMISS — JOINs against user_papers which is already validPevoPaperWhere-gated
- reputation.ts:citing_paper_quality (line ~720):
    DISMISS — same as paper_reviews
- notification-queries.ts:new_review arm 1a (line ~178):
    FOLD INTO ROUND-3 — gate added in round-2
- profile.ts:fetchUserReviewsFromHaf (line 317):
    [DECIDE] — this is the direct peer of getProfileStats; same file, same
    predicate family, same invariant; should be folded into round-3 or
    explicitly deferred
- profile.ts:getProfileStats user_reviews CTE (line 92-100):
    DEFERRED — track as separate task for ticketing
- search.ts:reviews search (line ~178):
    DISMISS — parent-paper JOIN gated by parent_author='' AND parent_permlink=$appTag;
    risk class is narrower
- papers.ts:fetchPaperDetailFromHaf reviews list (line ~947):
    [DECIDE] — does it JOIN to parent? If yes, audit gate composition
- stats.ts:review counters (line ~57):
    [DECIDE] — does it count un-gated reviews?

Items NOT in scope (the explicit frontier, derived from the enumeration above):
- getProfileStats user_reviews CTE — deferred as separate task (rationale: ...)
- search.ts reviews search — dismissed (parent-paper JOIN gated structurally; ...)
- [...]
```

The enumeration walks the same-file ring explicitly. Each site gets a disposition. The frontier note is the *output* of the audit, not its substitute.

### Generalized (any sibling-composition family)

The discipline applies to any composition family with an invariant:

- **Auth middleware coverage** — every route in the family must mount the middleware OR explicitly document why it's exempt. Walk routes by file, then by router-mount, then by module.
- **Logging field coverage** — every call site of the action must emit the structured field OR explicitly document why this call site doesn't need it.
- **Cache invalidation coverage** — every write path to the underlying data must invalidate the cache OR explicitly document why the path doesn't affect cached data.
- **Error-class propagation** — every catch block in the cascade must classify and re-throw the error class OR explicitly document why this catch is a terminus.

For each, the audit's structural shape is the same: enumerate sibling composition sites by widening rings; per-site explicit disposition; frontier note derived from the enumeration, not preceding it.

## Related

- `agents/docs/solutions/conventions/sql-semantic-shift-cross-surface-audit-2026-05-12.md` — sibling convention on cross-surface audit when a SQL gate's semantics shift. This entry covers the audit's enumeration discipline; that entry covers the surfaces a SQL semantic shift typically touches. Use together: that one names the surface families, this one names the enumeration ring structure.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — sibling on completeness discipline for wrapping primitives. Same rule shape: grep, enumerate, audit, don't infer "exhaustive" from "obvious" sites.
- `agents/docs/solutions/conventions/architect-hold-block-risk-class-separation-2026-05-07.md` — sibling on hold-block authorship discipline; complements this entry's "explicit enumeration before frontier" rule.
- `agents/docs/solutions/conventions/enumerated-exemption-lists-are-drift-vectors-2026-04-28.md` — sibling on the cost of enumeration that doesn't keep up; the "Items NOT in scope" note this entry's discipline produces is itself an enumerated exemption list and inherits that doc's drift concerns.
- `agents/docs/solutions/conventions/hold-block-shape-coverage-must-walk-full-lattice-2026-05-14.md` — sibling entry, same date, same family of "hold-block authorship enumeration completeness." That entry covers shape-coverage axes within a single guard; this entry covers composition-site enumeration across sibling guards.

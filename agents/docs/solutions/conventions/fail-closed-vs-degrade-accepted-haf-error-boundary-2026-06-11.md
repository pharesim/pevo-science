---
title: "Fail-closed vs degrade-accepted: the boundary for HAF-failure handling"
date: 2026-06-11
category: conventions
module: backend/src/routes/papers.ts + backend/src/routes/me.ts + backend/src/reputation.ts
problem_type: convention
component: database
severity: high
applies_when:
  - "Adding a catch, swallow, or degrade on any HAF-backed route, read helper, or batch computation"
  - "Reviewing error-handling asymmetries between surfaces that look structurally similar but carry different postures"
  - "Designing a read surface that composes multiple HAF queries where one is core data and another is a refinement"
  - "A surface serves as the authoritative record for its consumer (pending-consent list, reputation scores) rather than a display refinement"
  - "A batch computation writes results to a stateful store (watermark, cycle cursor, cached accumulator)"
tags: [haf, error-handling, fail-closed, graceful-degrade, reputation, authoritative-surface, cache-poisoning, retriable-503]
related_components: [background_job]
---

# Fail-closed vs degrade-accepted: the boundary for HAF-failure handling

## Context

PEvO's HAF-backed surfaces use two distinct error-handling postures: fail-closed (re-throw, or 503 retriable with the failure never cached) and degrade (serve core data with a refinement missing). During an architect review of the consent cluster, reviewers nearly flagged the asymmetry between `batchResolveVotes`'s catch-and-degrade and the fail-closed 503 posture on `annotateAuthorsWithConsent` / the pending-authorships endpoint as a design inconsistency. It is not: both postures are correct, and the deciding factor is the semantic category of the failed component. No repo-resident rule documented the boundary, so the next implementer or reviewer facing the call would re-derive it from scratch or, worse, unify the two postures in the wrong direction.

## Guidance

Decision checklist for any HAF-failure handling decision:

**Degrade is acceptable only when ALL of these hold:**

1. The failed component is a **display-parity refinement** whose authoritative enforcement lives in a separate, independently-correct subsystem (e.g. the reputation cycle owns self-dealing exclusion; the display-side exclusion is second-order parity).
2. **No stateful cursor, accumulator, or watermark advances** on the failure, and the degraded result is **not cached beyond a self-healing window** (the volatile tier, cleared each block tick, qualifies; a stable/long-TTL tier does not).
3. The degraded output is the **surface's core data intact minus the refinement** — never a fabricated-empty answer to a question the surface owns. A consumer reading the degraded output still gets complete core data.

**Fail-closed is required when ANY of these hold:**

- The surface **is the authoritative record** for its consumer: an empty result from a failure is indistinguishable from a legitimately empty answer at that consumer.
- The failure result would be **cached past the self-healing window** or would **advance a watermark/cursor** whose next state assumes the result was correct.
- The degraded output would silently corrupt downstream state (credit, consent, scores) rather than merely omitting a refinement.

**Corollary:** document the chosen posture with an inline rationale comment at each site, so a future editor does not blindly unify the postures in either direction. The vote-batch degrade and the consent-surface fail-closed sites each carry the canonical rationale shape.

## Why This Matters

Both failure directions cause real defects:

- **Blindly fail-closing the vote batch** reintroduces an availability cascade: a transient claims-query failure (statement_timeout class) would 503 the whole paper listing for the sake of a display-parity refinement whose authoritative enforcement already lives in the reputation cycle. Core vote data is unaffected by the refinement's absence.
- **Blindly degrading an authoritative surface** silently corrupts state: a HAF flap on the consented badge that degraded to a root-only answer would silently demote legitimate co-authors; an empty pending-authorships response from an outage is indistinguishable from "nothing pending" and hides actionable consents.
- **Blindly degrading the cycle** was the historical failure mode this boundary generalizes: a swallowed batch error returned an empty map indistinguishable from a legitimately empty cycle, advancing `cycle:last` and poisoning `prevScores` with no self-healing path.

## When to Apply

- Adding any `.catch`, swallow, or fallback on a HAF-backed path.
- Reviewing error-handling asymmetries flagged as "inconsistent" between similar-looking surfaces.
- Designing read surfaces composing core-data and refinement queries in one `Promise.all` (attach the degrade catch to exactly the refinement's promise; core-data failures must still reject).
- Any batch job whose output feeds a watermark, cursor, or score accumulator.

## Examples

**Degrade (correct) — `batchResolveVotes` in `backend/src/routes/papers.ts`:** the accepted-claims query's promise carries its own `.catch` that warns once per batch and returns null; the merge falls back to an empty claimed-set, so votes serve without the claimed-self-vote exclusion for one volatile-cache window. The native-vote and revote queries have no catch — core data failing still rejects the batch. All three degrade conditions hold: the exclusion is a parity refinement (cycle is authoritative), nothing stateful advances and the volatile tier self-heals next block, and the served output is complete vote data minus one refinement.

**Fail-closed (correct) — consented badge, `annotateAuthorsWithConsent` / `fetchConsentedAccountsForPaper` in `backend/src/routes/papers.ts`:** pool-null returns null (never cached — the cache helper skips null), query failure throws `HafQueryError`; the route maps both to 503 `SERVICE_UNAVAILABLE` with `retriable: true`. The badge is the authoritative consent answer for its consumer; a degraded root-only badge is indistinguishable from real consent state.

**Fail-closed (correct) — `GET /api/me/authorships/pending` in `backend/src/routes/me.ts`:** a HAF outage surfaces 503, never an empty 200, because an empty pending list is a legitimate answer the consumer acts on (stop waiting) — the two must stay distinguishable.

**Fail-closed (correct) — `computeReputationBatch` in `backend/src/reputation.ts`:** the catch re-throws unconditionally; the orchestrator bails without advancing the cycle. Failure here would otherwise be cached into cycle state (watermark + prevScores), violating condition 2 permanently.

**Known residual:** under a sustained failure cause (e.g. an on-chain claim flood that deterministically re-times-out the claims query on every refresh), a degrade re-fires every volatile window — "one window" describes transient failures. This is an accepted trade-off precisely because the authoritative cycle is unaffected; if the degraded refinement were authoritative anywhere, the same sustained cause would force the fail-closed posture instead.

## Related

- `reputation-cycle-last-must-not-advance-on-failure-2026-06-06.md` — the definitive cursor-advance pole of the fail-closed side (cycle-specific mechanics; this doc generalizes the triage criteria).
- `caching-wrapper-discriminated-union-poisoning-2026-05-11.md` — the adjacent caching decision: never persist a failure sentinel, whichever posture is chosen.
- `per-request-memo-catch-block-negative-cache-contract-2026-05-06.md` — within-request memoization discipline for catch blocks (asks "did you memoize the failure?"; this doc asks "should you swallow at all?").
- `single-flight-coalescing-amplifies-cache-invalidation-race-2026-05-20.md` — the volatile-tier mechanics that make the "self-healing window" condition real.
- `read-then-write-races-on-haf-backed-routes-2026-05-15.md` — the write-path-specific fail-closed/fail-open split this doc generalizes.
- `cascade-fns-rethrow-permanent-errors-2026-05-16.md` — structural parallel: re-throw discipline in the post-broadcast cascade domain.

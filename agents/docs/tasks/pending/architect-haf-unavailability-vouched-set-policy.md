# ARCHITECT-HAF-UNAVAILABILITY-VOUCHED-SET-POLICY — decide fail-open vs fail-closed for the consent-ops admit gate

**Owner:** Architect Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-code-review` on `backend-coauthor-trust-model` rounds 1+3)
**Priority:** P1 (blocks Round 2 of `backend-coauthor-trust-model`)

## Problem

Round 1 of the multi-author trust model landed `getVouchedAuthors` in `backend/src/consent-ops.ts`. Two failure modes currently produce indistinguishable empty results:

- `getPool()` returns `null` (HAF pool not configured / not connected) → `fetchConsentOpsForPaper` returns `[]` (consent-ops.ts:68).
- HAF query throws (transient network error, HAF restart, query-level error) → caught at consent-ops.ts:102-114 and returns `[]`.

Both paths feed `[]` to `computeVouchedAuthors`, which returns the root broadcaster as the only vouched author. Round 1 is not wired into the admit gate yet, so the blast radius today is zero. **The decision matters before Round 2 wires `getVouchedAuthors` into `resolveContinuationChain`'s admit gate** at `backend/src/routes/papers.ts` (lines around 632, 834 per current `main`).

## Why both options are imperfect

**Fail-open (return root-only vouched-set on HAF unavailability):**
- Currently implemented behavior.
- HAF down → all non-root co-author continuations rejected → public continuation surface degrades to "only the original author can continue."
- This is actually MORE strict than pre-Phase-2 behavior (which trusted any claimed author), so "fail-open" is something of a misnomer — it fails-closed against pre-Phase-2 baseline.
- Availability problem: legitimate co-authors with valid `author_accept` ops are blocked during HAF outage.

**Fail-closed (throw on HAF unavailability):**
- Paper-detail returns 503 INTERNAL_ERROR for any paper whose chain has multi-author content.
- Site goes down for paper detail when HAF is down. Bridge papers and single-author papers also fail-closed unless the gate distinguishes "no consent ops needed" up-front.
- Aligns with PEvO's "chain is SSoT" stance: if we can't read the chain, we can't answer the question.

**Hybrid (cache-and-degrade):**
- On HAF throw, return a cached vouched-set if one exists (last successful read for this paper) with a stale-marker.
- On no cache: fail-closed (throw → 503).
- Requires Round 2's cache layer to be aware of HAF availability state.

## Questions to resolve

1. Is the policy uniform across all consent-flow read sites (paper-detail, `/api/me/authorships/pending` from the sibling task), or per-site?
2. Should `fetchConsentOpsForPaper` distinguish "HAF returned empty" from "HAF threw" via the return type (e.g., `Promise<{ ok: true; ops: ConsentOp[] } | { ok: false; reason: 'haf_unavailable' }>`)? The caller can then choose policy at the integration site.
3. How does this interact with the cumulative-union task's HAF-required posture? `backend-multi-author-cumulative-union.md` (in `tasks/blocked/`) likely has the same question for its chain-walk.
4. What's the operator signal? On HAF outage, do we log per-request (noisy) or once-per-flap-window (sampled)?

## Acceptance

- Architect lands the policy in `agents/docs/ARCHITECTURE.md` Section 2, "Vouched-set computation (Phase 2 constraints)" subsection — pick ONE of the three options above (or another), justify the choice, document the operator-visible behavior on HAF outage.
- Architect amends `agents/docs/tasks/pending/backend-coauthor-trust-model.md` Round 2 plan to honor the chosen policy at the `papers.ts` integration site.
- If the policy requires `consent-ops.ts` API changes (e.g., the `ok: true | false` shape), file a follow-up `[TODO Backend]` note in the existing task file's Round 1 [TODO Architect] section so the round-1 implementer revisits the helper signature before Round 2 picks up.
- Cross-reference the policy from `backend-multi-author-cumulative-union.md` (whichever section discusses HAF-required vs HAF-fallback for the cumulative-union construction).

## Coordination

This task gates `backend-coauthor-trust-model` Round 2. It does NOT gate Round 4 (migration flag) — Round 4 wraps Round 2's integration site. It does NOT block any UI work on `ui-multi-author-consent-affordances` or `backend-notification-infra-for-consent-ops` (those consume the vouched-set output regardless of how HAF-down is handled internally).

## Source

`/ce-code-review` (rounds 1+3) on 2026-05-05: correctness reviewer (residual), reliability reviewer (P1, conf 85). Filed in the round-3 hold-block as item 4.

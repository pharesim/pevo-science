# ARCHITECT-BRIDGE-PAPER-IMMUTABILITY-DOC — document bridge papers as immutable; revisit option-b carve-out

**Owner:** Architect
**Created:** 2026-05-06 (filed at archive of `backend-continuation-post-author-consent-gate.md`, A6)
**Priority:** P2

## Problem

Bridge papers (`type: 'bridge_paper'`, authored by `config.hiveBridgeAccount`) are mirrors of external preprints (arxiv, crossref, etc.). They have a finalized canonical CID at publish time; the upstream source does not change once cited. Operationally, bridge papers never need to be updated post-publish.

Two surfaces still imply the opposite:
1. `agents/docs/ARCHITECTURE.md` "Bridge papers" subsection references update flows.
2. `backend/src/routes/papers.ts` `extractAuthorizedContinuationAuthors` carries an Option-b carve-out admitting `config.hiveBridgeAccount` as a legitimate continuation author for bridge papers (round-2 of `backend-continuation-post-author-consent-gate.md`, archived 2026-05-06).

The carve-out exists as defense-in-depth in case bridge updates are ever revived. Today they are dead code paths, but the documentation does not say so.

## Goal

Rewrite the ARCHITECTURE.md "Bridge papers" subsection to document bridge papers as immutable post-publish (no update flow). The Option-b carve-out for bridge-paper continuations stays in code as defense-in-depth, but its documentation should explicitly label it as inert under the current policy (revisit if the policy changes).

## Acceptance

1. **`agents/docs/ARCHITECTURE.md` "Bridge papers" subsection.** Rewrite to state that bridge papers are immutable post-publish: the bridge writer publishes the canonical mirror once and never updates it. Remove or rewrite any prose implying an update flow.

2. **Option-b carve-out documentation.** Add a brief note in the same subsection (or in the "Continuation-chain admission rule" surface, wherever the multi-author trust model section lands) that the carve-out admitting `config.hiveBridgeAccount` as a bridge-paper continuation author exists as defense-in-depth and is inert under the current immutability policy. If the policy is revisited, the carve-out becomes load-bearing.

3. **Cross-references.** Cross-link the companion implementation tasks: `backend-retire-bridge-update-route.md` (route removal) and `ui-retire-bridge-sync-affordance.md` (UI affordance removal). Note that both can land independently.

## Coordination

This task pairs with two implementer tasks (`backend-retire-bridge-update-route.md`, `ui-retire-bridge-sync-affordance.md`) but does not block on them. The doc rewrite can land first and is reversible if the immutability decision is later relaxed.

## Cross-references

- `agents/docs/ARCHITECTURE.md` — "Bridge papers" subsection.
- `backend/src/routes/papers.ts` — `extractAuthorizedContinuationAuthors` Option-b carve-out.
- `agents/docs/tasks-archive.md` — round-2 of `backend-continuation-post-author-consent-gate.md` (archived 2026-05-06) for the original Option-b ratification.

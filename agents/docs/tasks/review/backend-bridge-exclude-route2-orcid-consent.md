# BACKEND-BRIDGE-EXCLUDE-ROUTE2-ORCID-CONSENT — exclude bridge papers from Route-2 ORCID consent eligibility

**Owner:** backend
**Created:** 2026-06-14 (architect, settling the embedded boundary decision in `backend-bridge-paper-author-claim-flow`)
**Priority:** P3 (defensive boundary; no live defect — the real-postgres corpus pins only the no-match case today — but the boundary becomes reachable as bridge-with-ORCID imports and ORCID attestations both grow)

## Problem

The live Route-2 ORCID eligibility arm in `consentedAuthorsCteBody` (`backend/src/hafsql.ts`) does not exclude bridge papers. A bridge-paper `authors[]` slot carrying a source ORCID that matches a live authority-attested accreditation would let that account `author_accept` into reputation/citation credit — bypassing the verified bridge-claim flow (`backend-bridge-paper-author-claim-flow`, deferred).

This is unsafe by provenance: a bridge slot's ORCID is **external preprint metadata** (self-asserted at arXiv/Crossref), not a slot asserted by an accountable accredited PEvO poster (the native Route-2 case). Architect decision (recorded in `backend-bridge-paper-author-claim-flow`, 2026-06-14): bridge papers remain single-consented (bridge account only) until the verified claim flow lands; they do NOT admit a direct Route-2 ORCID consent shortcut. This violates `pevo-object-identity-is-author-vouching-not-metadata-claim` only if left open — the guard restores the principle (gates terminate in a verified identity link, not un-revouched external metadata).

No live defect today: the security note that surfaced this (during the `backend-implement-consented-authorship-model` review, conf 50) confirmed no current bridge slot ORCID matches an attested account, and the real-postgres corpus pins only the no-match case.

## Goal

The Route-2 ORCID consent arm does not admit a bridge paper's slot into the consented set, even when the slot's source ORCID matches an attested accreditation. Bridge papers stay single-consented (bridge account / Route-1) until the verified claim flow lands.

## Acceptance

- The `consentedAuthorsCteBody` Route-2 ORCID eligibility arm excludes bridge papers (use the existing bridge predicate — `isPevoBridgePaper` / the bridge-account marker the listing already short-circuits on; the implementer picks the SQL-side expression of it that fits the CTE).
- A real-postgres FROM-redirect corpus case where a **bridge** slot's ORCID matches an attested account asserts the account is NOT in the consented set for that paper (the inverse of the existing no-match pin). The non-bridge ORCID-match case stays consented (no regression to native Route-2 ORCID consent).
- The cycle-vs-display credited-set parity is preserved: the same exclusion applies wherever `consentedAuthorsCteBody` is composed (the cycle AND the display surfaces), so no drift is introduced. The existing consented behavioral canaries stay green.
- Comment anchors on stable symbols; `npm run typecheck` + `npm run lint` clean.

## Cross-references

- `backend/src/hafsql.ts` — `consentedAuthorsCteBody` (the Route-2 ORCID arm), `consentChainCteBody`; the bridge predicate (`isPevoBridgePaper` in the routes / its SQL expression).
- `agents/docs/tasks/blocked/backend-bridge-paper-author-claim-flow.md` — the deferred verified claim flow this guard holds the line for; the 2026-06-14 boundary decision.
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — the convention this restores.
- Archived parent in `tasks-archive.md`: `backend-implement-consented-authorship-model` (where the boundary was flagged).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

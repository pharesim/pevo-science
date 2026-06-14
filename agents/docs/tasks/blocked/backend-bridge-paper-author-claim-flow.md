# BACKEND-BRIDGE-PAPER-AUTHOR-CLAIM-FLOW — let original preprint authors claim authorship of imported bridge papers

**Owner:** Backend Agent (with architect design lead in Phase 1)
**Created:** 2026-05-05 (architect, surfaced by `/ce-doc-review` of `agents/docs/ARCHITECTURE.md` Multi-Author Trust Model section)
**Priority:** P2 (deferred until a real user surfaces; stub task for triage visibility)
**Status:** NOT YET SCOPED. Phase 1 brainstorm + design required before implementation.

## Problem

Bridge papers (imported from arXiv, Crossref, etc. via the bridge service) carry `pevo.authors[]` entries with `hive: null` for original-preprint authors who lack Hive identity. Per the Multi-Author Trust Model in `agents/docs/ARCHITECTURE.md`, these entries are claimed but never vouched — the bridge account is the sole vouched continuator.

When a real original-preprint author joins Hive (registers a handle, e.g., `alice`), they may want to claim authorship of an imported bridge paper that lists them. The current model has no path: alice cannot directly broadcast `author_accept` because the existing `pevo.authors[]` entry has `hive: null`, not `hive: 'alice'`. There is no on-chain link between the imported paper's display-only credit and alice's new Hive identity.

This task is deferred until a real user surfaces. PEvO is in beta; bridge-paper imports are populated automatically by the bridge service; original authors haven't yet joined and asked to claim. When they do, this task picks up.

## Goal (high-level, to be brainstormed in Phase 1)

Design + implement the verification flow that lets a real original-preprint author claim authorship of a bridge paper they were imported into.

## Open design questions (Phase 1 brainstorm seeds)

1. **Verification: how does PEvO confirm "alice on Hive" is the same person as "Alice Researcher" on the original arXiv preprint?**
   - ORCID-mediated: alice authenticates with her ORCID; ORCID record includes the preprint authorship; PEvO trusts ORCID's verification.
   - Email-mediated: alice provides the email associated with the preprint corresponding-author role; PEvO sends a verification token; alice broadcasts proof on chain.
   - Bridge-service-mediated: bridge service (which already verifies preprints) issues an attestation linking alice's Hive handle to the original-preprint metadata.
   - Manual admin attestation: an accreditation authority verifies off-chain and signs an on-chain attestation.

2. **On-chain primitive for the verification.** Likely a new `custom_json` op type signed by an accreditation authority (or the bridge service's pinned account):
   - `id: APP_TAG`
   - `required_posting_auths: [<authority>]`
   - payload: `{type: 'bridge_author_attestation', root_author: <bridge_account>, root_permlink: <paper_permlink>, original_credit_index: <index_in_pevo.authors_array>, claimant_hive: 'alice'}`

3. **Effect on the paper's metadata.** After attestation:
   - Alice can broadcast `author_accept` and become vouched.
   - The displayed authors list shows alice with her PEvO badge (her name resolves to her Hive profile).
   - The other bridge-paper entries (still `hive: null`) remain display-only.

4. **Multiple claimants for the same display credit.** What if "Alice Researcher" is a common name and two Hive accounts both claim the same display credit? The verification flow must prevent this (e.g., ORCID disambiguates; or the first valid attestation wins; or admin manually resolves).

5. **Bridge papers that are never updated** (per ARCH.md "Bridge papers" subsection: bridge papers are imported once, never updated). The attestation flow needs to operate WITHOUT requiring a continuation broadcast that updates the paper's metadata. The attestation custom_json sits alongside the paper, not inside it.

## [Architect] (2026-06-11) — design input from the consented-authorship review

The `/ce-code-review` security lens on `backend-implement-consented-authorship-model` flagged (confidence 50): the live Route-2 ORCID eligibility arm in `consentedAuthorsCteBody` does not exclude bridge papers, so a bridge-paper `authors[]` slot carrying a source ORCID that matches a live authority-attested accreditation would let that account `author_accept` into credit ahead of this task's verification design. Today no bridge slot ORCID matches an attested account (the real-postgres corpus pins only the no-match case), so this is a design-boundary note, not a live defect. When Phase 1 is brainstormed, decide explicitly whether bridge papers admit direct Route-2 ORCID consent (which would partially obsolete the attestation flow above for ORCID-bearing slots) or remain single-consented-author until the verified claim flow lands; if the latter, the eligibility arm needs a bridge exclusion plus a corpus case where a bridge slot ORCID matches an attested account.

6. **Vouched-set computation extension.** The vouched-set query (Phase 2 of `backend-coauthor-trust-model`) reads `author_accept` ops. It must also read `bridge_author_attestation` ops to map a `hive: null` display credit to a vouched Hive handle, then check for alice's `author_accept`.

## Acceptance (to be sharpened during Phase 1 brainstorm)

This is a P2 deferred task. Acceptance is the design + implementation, but only when a real user surfaces.

### Phase 1: brainstorm + design (when triggered)

`/ce-brainstorm` on the verification flow with the architect. Output: spec text added to `agents/docs/ARCHITECTURE.md` under section 2 "Multi-Author Trust Model" (a `#### Bridge-paper authorship claim` subsection extending the existing "Bridge papers" subsection), plus the new `custom_json` op type definition. `/ce-doc-review` pass before Phase 2.

### Phase 2: implementation

- New `custom_json` op type validation in HAF query layer.
- Vouched-set computation extension to honor bridge-paper attestations.
- Frontend affordance for users to initiate a claim (likely on the bridge paper's display page or in account settings).
- Verification flow (whichever Phase 1 picks: ORCID, email, manual, etc.).
- Tests covering: legitimate claim, duplicate-claim rejection, common-name disambiguation, attestation revocation if mis-issued.

## Out of scope

- Bulk-claiming all bridge papers an author was imported into. The flow is per-paper.
- Migrating the existing bridge-import pipeline to capture Hive handles preemptively. The model is "import once with `hive: null`, claim later if/when the original author joins."
- Authorship disputes between the bridge service and a claiming author (handled by admin governance, not this metadata layer).

## Cross-references

- `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust Model" → "Bridge papers" subsection — the canonical spec for bridge-paper authorship today, which this task extends.
- `agents/docs/tasks/pending/backend-coauthor-trust-model.md` — Phase 2 of the multi-author trust model; bridge-paper claim flow layers on top of it.
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — the convention this attestation flow must respect (every gate terminates in an identity predicate).

## Trigger

This task is filed as a stub for triage visibility. Pick up when:
- A real original-preprint author asks PEvO support / the architect to claim a bridge paper, OR
- The bridge service's import volume reaches a threshold where claim requests are anticipated, OR
- A future architect / product decision elevates this to active work.

Until triggered, this file lives in `tasks/blocked/` (BLOCKED by Architect). The architect owns Phase 1 brainstorm + design; backend cannot proceed without that. When a trigger fires and the architect lands Phase 1 design in `ARCHITECTURE.md`, the architect `git mv`s this file back to `tasks/pending/` for backend pickup of Phase 2 implementation.

## [BLOCKED by Architect] (backend startup triage 2026-05-11)

Body status is "NOT YET SCOPED. Phase 1 brainstorm + design required before implementation," with the architect as Phase 1 design lead. Backend cannot pick this up speculatively — the verification primitive, on-chain op shape, and vouched-set extension are all architect-owned design decisions that must land in `ARCHITECTURE.md` before backend implements.

The "Trigger" section already documents the external conditions for activation (real user request, volume threshold, or architect elevation). Moving to `blocked/` so backend's `pending/` queue reflects only actionable tasks and the architect's startup scan surfaces this when a trigger fires.

When triggered, the architect runs `/ce-brainstorm` per Phase 1, lands the design in `ARCHITECTURE.md`, and `git mv`s this file back to `pending/` for backend Phase 2 implementation.

## [Architect] (2026-06-14) — embedded boundary decision settled; full flow STAYS deferred (no trigger)

Reviewed at the architect-blocked sweep. The full claim flow is correctly deferred — none of the Trigger conditions has fired (no real original-preprint author has asked to claim; bridge import volume has not crossed a claim-anticipation threshold; no product elevation). The Phase-1 brainstorm would be speculative without real user requirements, so this **stays in `blocked/`**.

But the 2026-06-11 design-input note raised a boundary question that IS live now that the consented model has shipped, so it is settled here so it does not block at trigger time:

**Decision (Q from the 2026-06-11 note): bridge papers do NOT admit a direct Route-2 ORCID consent shortcut.** They remain single-consented (bridge account only) until this verified claim flow lands. Rationale: a bridge slot's ORCID is **external preprint metadata** (self-asserted at arXiv/Crossref), not a slot asserted by an accountable accredited PEvO poster (the native Route-2 case). Gating reputation/citation credit on un-revouched external metadata is precisely what this verified claim flow exists to prevent, and it leans against `pevo-object-identity-is-author-vouching-not-metadata-claim` (gates terminate in a verified identity link, not a metadata claim). This keeps the eventual Phase-1 design's full scope intact (it does NOT obsolete the attestation flow for ORCID-bearing slots — all bridge slots, ORCID-bearing or name-only, route through the verified flow). It is the conservative, reversible default: if a future product decision prefers the Route-2 ORCID shortcut, the exclusion is one predicate to remove.

**Near-term defensive guard filed separately:** `backend-bridge-exclude-route2-orcid-consent` (pending/) adds the bridge exclusion to the live `consentedAuthorsCteBody` Route-2 ORCID arm + a corpus case where a bridge slot ORCID matches an attested account (asserting it confers NO consent). No live defect today (the real-postgres corpus pins only the no-match case), but the boundary becomes reachable as bridge-with-ORCID imports and ORCID attestations both grow, so it is closed now rather than left to coincide. This is the "if the latter, the eligibility arm needs a bridge exclusion plus a corpus case" action from the 2026-06-11 note.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

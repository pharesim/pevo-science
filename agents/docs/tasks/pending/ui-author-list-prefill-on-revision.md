# UI-AUTHOR-LIST-PREFILL-ON-REVISION — prefill the author list when revising a paper so co-authors aren't accidentally dropped

**Owner:** UI Agent
**Created:** 2026-05-26 (architect, from the author-identity-model `/ce-brainstorm`)
**Priority:** P2

## Problem

When a user revises a paper (broadcasts a continuation), the publish/edit form is the place a co-author can silently vanish: if the form starts empty or with a partial author list, the broadcaster re-types only the authors they remember, and the rest are dropped from that post's `pevo.authors[]`. The backend read-path cumulative-union (`backend-author-identity-model`) reconstructs dropped authors at display time, but that is a backstop for chain data already published and for direct-Keychain broadcasts that bypass the PEvO frontend. The frontend should prevent honest drops at the source.

This is the write-path companion to the read-path persistence fix. The two are independent and land separately.

## Goal

On the revision/continuation flow, prefill the author list from the prior version so a revision defaults to keeping every existing author, and require a name on each entry.

## Requirements

### R1 — Prefill the full prior author list

- When the user opens the revise/continue flow for an existing paper, prefill the author editor with the **complete author list from the prior version** — every entry, including `name`, `hive`, `orcid`, `affiliation`, and Hive-less (`hive: null`) display-only credits. The default state of a revision is "same authors as before."
- Adding a new co-author stays allowed (the trust model permits additions; new entries are claimed-pending until they accept). Removing an existing entry must be a deliberate user action, not the default of an empty form.
- Consider (UI agent's call) making existing entries' removal an explicit, confirmed action versus freely editable — the requirement is that the prior list is the prefilled default; the exact affordance for removal is a UI-design decision.

### R2 — Name required per entry

- Every author entry in the form requires a non-empty `name` before the form can be submitted. Consistent with the ratified model (`name` mandatory; no grandfathered posts). For an accredited co-author the backend will server-override the name with the attested value at display time, but the form still collects a name (the broadcaster's claim is what lands on chain).

### R3 — Source of the prior list

- Pull the prior author list from the paper's current API response (the `authors[]` the detail surface already returns), not by re-deriving from raw chain metadata. The displayed `authors[]` is already the cumulative-union/supersession-resolved set, so prefilling from it carries forward the complete author set the backend computed.

## Acceptance

- Opening a revision on a multi-author paper shows all existing authors pre-populated, including Hive-less credits.
- Submitting a revision without touching the author list re-broadcasts the same author set (no silent drop).
- The form blocks submission if any author entry lacks a name.
- Unit/component test for the prefill-from-prior-version behavior; a test asserting submit is blocked on a name-less entry.
- New microcopy (if any) added to `frontend/public/messages/*.json` with English source + stubs per the existing i18n pattern.

## Out of scope

- The backend read-path cumulative-union and name-supersession — `backend-author-identity-model`.
- The consent-op accept/resign affordances and migration banner — `ui-multi-author-consent-affordances` (blocked).
- Backend broadcast-time validation of author entries — not pursued (can't cover direct-Keychain; deliberately a UI-form guard plus backend read-time fallback).

## Cross-references

- `agents/docs/tasks/pending/backend-author-identity-model.md` — read-path companion; the source of the ratified model.
- `agents/docs/ARCHITECTURE.md` § 2 "Multi-Author Trust Model" — additions allowed, removals only via `author_resign`; this form defaults to no-drop.

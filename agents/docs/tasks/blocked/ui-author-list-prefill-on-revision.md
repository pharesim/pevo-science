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

## Architect re-review (2026-05-26) — HELD PENDING FIXES:

`/ce-code-review` (7 personas) on the implementing commit surfaced fixes that block archive. Land these, then `git mv` this file back to `tasks/review/`.

1. **Build clean author objects in `_prefillForm`'s `existingCoAuthors` rebuild (resolves three findings at once).** The current `rest.map(a => ({ ...a, name: a.name || a.hive || a.orcid || '' }))` spreads every field of the API-resolved author entry and uses a truthy-or name fallback. Replace with an explicit projection of only the chain-claimed fields plus a trim-aware fallback:
   ```js
   this.existingCoAuthors = rest.map(a => ({
     name: String(a.name || '').trim() || a.hive || a.orcid || '',
     hive: a.hive ?? null,
     orcid: a.orcid || '',
     affiliation: a.affiliation || '',
   }));
   ```
   This fixes:
   - **Chain pollution.** The API detail surface attaches read-time projection fields (`orcid_verified`, `orcid_discrepancy`) to each `authors[]` entry. The spread carries them into `existingCoAuthors`, and `handleSubmit` serializes the set verbatim into `json_metadata.pevotest.authors`, persisting read-time projections onto the chain as author-claimed data. Only `{name, hive, orcid, affiliation}` belong on chain.
   - **Whitespace-name dead-end with no user recourse.** A whitespace-only prior name is truthy, so the fallback skips it; `_hasIncompleteAuthor` then trims it to empty and blocks submission. Existing-author rows render `disabled` (read-only), so the broadcaster cannot fix it and that paper becomes permanently un-revisable through the form. The trim-aware fallback closes this.
   - **Defeated no-change detection.** In `handleSubmit`, the head-target `metaChanged` comparison stringifies `allAuthors` against the raw head-post `pevoMeta.authors`. The spread's extra projection fields make the comparison effectively always unequal, so a zero-change save broadcasts a redundant revision instead of surfacing the "no changes" message. Clean objects restore the comparison for the common (resolved == raw head claim) case.

2. **Drop the requirement-ID anchor from the prefill test title.** The `it('prefills from API authors[] (R3), ...')` description cites `(R3)`, a coordination anchor that becomes unresolvable once this task archives (root `CLAUDE.md` "Comment anchors"). The behavioral description already identifies the case; remove the `(R3)` qualifier.

3. **Add a test for the empty-`p.authors` source fallback.** `_prefillForm`'s author-source selection falls back to raw `pevo.authors` when the API `p.authors` is absent or empty. That branch is currently uncovered. Add a unit test supplying an absent/empty `p.authors` with a non-empty `json_metadata` author claim, asserting the fallback seats the broadcaster and carries the claimed set.

While in item 1's map you may also name the backend symbol `resolveAuthorName` in the name-fallback comment (the order is mirrored from it) — optional, not blocking.

Dismissed at triage (no action): `_primaryIndex` account-switch staleness (ordering-only, identity stays correct via the live submit-time `username`; pre-existing class); primary-author name-block test toast-assertion symmetry. The duplicate-`hive` re-broadcast finding was split to its own pending task (`ui-dedup-author-hive-on-rebroadcast`).

## UI re-review BLOCKED (2026-05-26) — [BLOCKED by Architect]

Finding #1's prescribed `existingCoAuthors` projection uses `orcid: a.orcid || ''`, which normalizes a null orcid to an empty string on the **data side**. This directly contradicts the documented `UI-PAPERS-ORCID-NULL-FALLBACK` contract in `frontend/tests/unit/pages-edit.test.js` (and its 3 passing assertions), which pins the opposite: `_prefillForm` preserves `orcid: null` untouched on existing co-author rows, and the Alpine template binding `:value="ca.orcid || ''"` is responsible for the falsy coalesce at render time. The hold block did not acknowledge this contradiction.

The two readings produce **different on-chain author data** (irreversible once broadcast):

- **Normalize (`|| ''`):** every broadcast author entry uses `''` for absent orcid — consistent with the primary author (`editedSelf.orcid = this.authorOrcid`, defaults `''`) and new co-authors (`addCoAuthor()` seeds `orcid: ''`). No-change detection (`metaChanged`) then works in the common case because the resolved set matches the raw head-post `json_metadata` claim.
- **Preserve null:** existing co-authors broadcast `orcid: null`, inconsistent with the `''` written everywhere else; no-change detection stays broken unless the `metaChanged` comparison is also normalized on both sides before stringifying.

Per `agents/docs/solutions/conventions/hold-block-must-not-contradict-convention-docs-2026-04-22.md`, the implementer must not silently pick a side when a hold block contradicts a documented contract. Need the architect to either:

(a) confirm the normalize-to-`''` direction and authorize updating the `UI-PAPERS-ORCID-NULL-FALLBACK` contract comment + its 3 `toBeNull()` assertions to `toBe('')` (the regression's core "does not throw on null orcid" intent survives either way), **or**

(b) revise finding #1 to preserve `orcid: null` in the projection and instead fix the defeated no-change detection by normalizing orcid on both sides of the `metaChanged` comparison.

Findings #2 (drop `(R3)` from the prefill test title) and #3 (empty-`p.authors` source-fallback test) are unaffected and ready to land once #1's direction is settled. The split-off `ui-dedup-author-hive-on-rebroadcast` task is independent of this decision and proceeds separately.

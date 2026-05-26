# BACKEND-AUTHOR-IDENTITY-MODEL — name-supersession + Hive-less co-author persistence in the cumulative-union

**Owner:** Backend Agent
**Created:** 2026-05-26 (architect, from the author-identity-model `/ce-brainstorm` spun off the `backend-cumulative-union-listing-surfaces-parity` round-3→round-4 deferral)
**Priority:** P1

## Problem

Two structural gaps in the author-identity model, both rooted at the cumulative-union construction (`buildCumulativeAuthorsForChain` in `backend/src/routes/papers.ts`) and its shared supersession projection:

1. **Hive-less co-authors are structurally dropped on multi-link papers.** The cumulative-union dedups entirely on `hive` (`const hive = normalizeHiveAccount(entry.hive); if (hive === null) continue;`). Every author entry without a resolvable Hive account is skipped before it can win, so on a multi-link paper the union drops every `{name, hive: null}` co-author from `authors[]` — listing, profile, and detail all lose them. Single-link papers are spared only by the `chain.length === 1` short-circuit (which preserves the head-meta projection's carrier entries). This violates the "authors can't be dropped" invariant the cumulative-union exists to uphold, now seen from the Hive-less side. A Hive-less author can never sign a continuation, so they only ever appear as a *listed* co-author in some broadcaster's `authors[]`; carrying them across links is a display-completeness concern, not a vouching one.

2. **No name-supersession.** The cumulative-union loop server-overrides `orcid` for accredited hives (and surfaces `orcid_verified` / `orcid_discrepancy`), but never overrides `name`. An accredited author's attested name (`active_accreditations.researcher_name`, already exposed by the CTE and already LEFT-JOINed in `authorsWithSupersessionSelect`) is the authoritative display name and should win over whatever the broadcaster typed — exactly as ORCID does.

These compound into a type-soundness gap: `PaperAuthor.name` is declared `name: string` (required) but the construction can emit entries with no `name`, and the current `.filter((a): a is Record<string, unknown> & PaperAuthor => typeof a.hive === 'string')` guard asserts `PaperAuthor` while only checking `hive`. Making `name` genuinely mandatory (below) is what makes that guard soundly expressible on `name`.

## Ratified model (from the 2026-05-26 brainstorm — treat as given)

- **`name` is mandatory** on every author; **`hive` is optional** (a co-author need not have a Hive account).
- **No grandfathered posts.** PEvO is beta; there is no legacy production data to preserve compatibility with. Clean cutover, no grandfather-exception path (consistent with the trust model's existing hard-cutover migration stance).
- **Name-supersession is silent.** The accredited author's attested name wins for display. No `name_discrepancy` field, no audit event — name variation (Rob/Robert, maiden names, transliterations, initials) is benign and high-noise, unlike an ORCID mismatch.

## Goal

Extend the cumulative-union + shared supersession projection so (a) Hive-less co-authors persist across chain links, (b) an accredited author's attested name supersedes the broadcaster claim, and (c) `PaperAuthor.name` is a sound mandatory `string` across every surface. Land as one coherent change so no intermediate state ships where one surface drops Hive-less authors while another carries them, or where `name` is mandatory in the type but unpopulated at a surface.

## Requirements

### R1 — Hive-less co-author persistence (composite-key union)

- Dedup author entries on **two separate tracks**:
  - **Hive-keyed entries** dedup on the normalized `hive` value (unchanged from today, including the most-recent-self-claim-wins / else-most-recent-fallback resolution and first-occurrence ordering).
  - **Hive-less entries** (`hive` absent/null/non-normalizable) dedup on a **composite key: `orcid` (normalized) when present, else the normalized `name`**. They are carried into the cumulative union, not skipped.
- **The two tracks never merge.** A Hive-less entry MUST NOT be folded into a Hive-keyed entry by matching name or ORCID. Auto-linking a display-only credit to a Hive account by fuzzy name/ORCID is explicitly forbidden by the trust model (`ARCHITECTURE.md` § 2 "Bridge papers"); the explicit bridge-author-claim attestation flow (`backend-bridge-paper-author-claim-flow`, blocked) remains the only path that links a Hive-less credit to a Hive identity. If the same human appears once with a Hive handle and once without, they may double-list until that attestation lands — accepted.
- Over-merge (two distinct people sharing a normalized name collapse) and under-merge (one person spelled two ways double-lists) are accepted cosmetic outcomes on informational-only credits. Name-supersession does not normalize Hive-less names (no accreditation to attest against).
- Ordering: Hive-less entries take their place in the displayed `authors[]` by first-occurrence across the chain, consistent with the existing hive-keyed ordering rule.

### R2 — Name-supersession (silent override)

- For a Hive-keyed entry whose account is **currently accredited** and whose accreditation carries a non-empty name, the **attested name supersedes** the broadcaster-claimed `name` for display. Mirror the placement of the existing ORCID server-override in the cumulative-union loop.
- **No `name_discrepancy` / `name_verified` field is added**, and **no audit event** fires on a name mismatch. The resolved `name` simply carries the authoritative value. (Contrast ORCID, which retains the raw claim plus `orcid_verified`/`orcid_discrepancy` because the divergence is a security signal; name divergence is not.)
- Name-supersession applies only to currently-accredited Hive accounts. Revoked / unaccredited / Hive-less entries keep their broadcaster name (then the R3 fallback).

### R3 — `name` mandatory + defensive read-time fallback

- `PaperAuthor.name` becomes a required `string` in `backend/src/types/domain.ts` (no longer optional).
- Read-time population order, applied at every surface so the type is always satisfiable: **attested name (if accredited) → broadcaster `name` → `hive` handle → `orcid`**. The fallback is defensive: chain is SSoT and a direct-Keychain broadcast can omit `name`, and dropping that entry would itself violate "authors can't be dropped." It is not a legacy-compat shim (there are no grandfathered posts).
- With `name` now always populated, replace the unsound `typeof a.hive === 'string'` exit-boundary guard with a sound `name`-based narrowing, or drop the guard if the enumerated projection already guarantees the `PaperAuthor` shape. The `hive`-discriminator deviation introduced under the round-3 hold becomes unnecessary.

### R4 — SQL ↔ JS parity

- Name-supersession and the R3 fallback MUST land on **both** the SQL projection (`authorsWithSupersessionSelect` in `backend/src/hafsql.ts`, used by listing + detail) and the JS helpers (`applyAuthorSupersession` / `computeSupersession` in `backend/src/lib/author-supersession.ts`, and the cumulative-union construction in `papers.ts`), in lockstep. The SQL/JS parity doctrine (documented atop `author-supersession.ts` and `authorsWithSupersessionSelect`) is binding: drift between the two surfaces is a cross-surface parity break. The accreditation CTE already exposes `researcher_name`, so the SQL side is a projection change, not a new query.
- After the change, single-link and multi-link surfaces MUST emit an **identical author-object shape** (the multi-link-vs-single-link key-shape divergence the round-4 deferral flagged — JS dropping `name`/`orcid` keys for hive-less entries while SQL emits `null` — is closed by R1 carrying hive-less entries and R3 making `name` total).

## Acceptance

- Multi-link paper with a Hive-less co-author dropped by the head broadcaster: detail / listing / profile all include that co-author in `authors[]` (composite-key reconstruction).
- Accredited author whose broadcaster-claimed name differs from their attested name: every surface displays the attested name; no `name_discrepancy` field appears; no audit event is emitted.
- `PaperAuthor.name` is `string` (mandatory) in `domain.ts`; the unsound guard is replaced/removed; `npm run typecheck` clean with no `as unknown as` laundering at the helper boundary.
- A direct-broadcast entry with no `name` (only `hive`, or only `orcid`) is NOT dropped — it surfaces with the fallback display name.
- SQL and JS author-object shapes are identical for the same author across single-link and multi-link papers (enumerated-key parity canary extended to cover `name` population and Hive-less carry).
- Deterministic canaries: composite-key dedup (orcid-track and name-track), the two-track no-merge boundary (a Hive-less entry and a Hive-keyed entry for the same human stay separate), silent name-override (attested wins, no discrepancy field), and the fallback chain. Real-HAF cross-surface parity canary extended to assert Hive-less persistence.
- Scoped vitest on the cumulative-union + cross-surface-parity files passes; full backend suite passes with existing scoped exclusions. The 14 fixtures that currently use bare `{hive: 'alice'}` entries get a `name` per R3 (no grandfathered posts → fixtures model the cutover reality).

## Out of scope

- The held `backend-cumulative-union-listing-surfaces-parity` item 1 (profile-guard empty-cumulative fallback). Independent; do not conflate. This task assumes that fix has landed or lands separately.
- Bridge-paper author-claim attestation (`backend-bridge-paper-author-claim-flow`, blocked) — the explicit Hive-less→Hive linking path. This task does NOT auto-link by name/ORCID.
- Backend broadcast-time name-rejection validation — can't cover direct-Keychain broadcasts; the R3 read-time fallback plus the UI form (`ui-author-list-prefill-on-revision`) are the chosen guards.
- The single-link negative-cache sentinel / cold-path re-probe optimization — deferred per the parent task's prior architect decision.
- Write-path prefill of the author list on revision — separate UI task `ui-author-list-prefill-on-revision`.

## Architect doc edits (land at archive, NOT implementer's job)

[TODO Architect] These fold into the § 2 trust-model rewrite tracked by `architect-cumulative-union-doc-edits` (blocked):
- `agents/docs/hive-schemas.md` § 1.1 — add the name-supersession rule alongside the existing ORCID supersession rule; mark `authors[i].name` mandatory with the read-time fallback order; note that name-supersession is silent (no discrepancy signal, unlike ORCID).
- `agents/docs/api-contracts/papers.md` — `PaperSummary.authors[]` and `PaperDetail.authors[]`: `name` mandatory; name-supersession (attested wins, silent); confirm no new field is added.
- `agents/docs/ARCHITECTURE.md` § 2 "Multi-Author Trust Model" — note that Hive-less display-only credits persist across chain links via composite-key union (the claimed-set narrative is hive-keyed for *vouching*; this is the display-completeness companion), and that the two tracks never auto-merge (the bridge-author-claim attestation flow is the only Hive-less→Hive link).

## Cross-references

- `agents/docs/tasks/pending/backend-cumulative-union-listing-surfaces-parity.md` — parent; the round-3→round-4 deferral note is the origin of this task.
- `agents/docs/tasks/pending/ui-author-list-prefill-on-revision.md` — write-path companion.
- `agents/docs/tasks/blocked/architect-cumulative-union-doc-edits.md` — where the doc edits land.
- `agents/docs/tasks/blocked/backend-bridge-paper-author-claim-flow.md` — the forbidden-auto-merge boundary's explicit alternative.
- `backend/src/routes/papers.ts` `buildCumulativeAuthorsForChain` — the construction; `backend/src/hafsql.ts` `authorsWithSupersessionSelect` — SQL projection; `backend/src/lib/author-supersession.ts` — JS parity helpers; `backend/src/types/domain.ts` `PaperAuthor` — the type.

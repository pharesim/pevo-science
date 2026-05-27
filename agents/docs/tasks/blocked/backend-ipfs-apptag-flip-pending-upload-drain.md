# BACKEND-IPFS-APPTAG-FLIP-PENDING-UPLOAD-DRAIN — guard the cleanup unpin decision across an APP_TAG value change

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by the IPFS-cluster `/ce-code-review` — adversarial P2, operational)
**Priority:** P3

## Context

`cidReferencedInHaf` (`backend/src/ipfs-cleanup.ts`) scopes its HAF reference check to the current `config.appTag` — both the `c.tags @> [appTag]` index scope and the `{[appTag]: …}` containment namespace. This is correct behavior for any single APP_TAG value at runtime.

But when `APP_TAG` flips from the beta value (`pevotest`) to its production value, the failure mode is real and irreversible:

- A `pending_ipfs_uploads` row created under `pevotest` within the prior 24h (the cleanup `MAX_AGE` window) survives the flip.
- On the next sweep, `cidReferencedInHaf` scopes `tags @> [prodtag]` and matches namespace `{prodtag: …}`. The still-on-chain `pevotest`-tagged paper is tagged and namespaced `pevotest`, so **both predicates miss** → `referenced = false` → `unpinFromIpfs` + DELETE.
- A live, on-chain-referenced paper file is unpinned (Kubo `pin/rm` is not refcounted — no recovery).

The blast radius is bounded to rows younger than the 24h `MAX_AGE` at flip time, but the mechanism is a silent data-loss path that single-appTag-at-runtime correctness does not neutralize — it just defers the loss to flip day.

This was an explicit **non-goal** of the predecessor scan-scope task (the beta→prod corpus migration is its own concern), so it is filed separately here rather than folded in.

## Goal

Make the eventual APP_TAG flip safe against unpinning live `pevotest`-era files. Decide between the operational and the code mitigation (or both); the operational one is the floor:

- **(operational, minimum)** Document a flip-day runbook step: before changing `APP_TAG`, drain `pending_ipfs_uploads` — let all rows age past `MAX_AGE` and be reaped (or hold the flip until the table is empty) so no stale-namespace row reaches a post-flip sweep. Put this in `agents/docs/ARCHITECTURE.md` near the IPFS-cleanup / appTag description (architect owns that file — coordinate, or request the note).
- **(code, optional hardening)** During a transition window, widen the cleanup reference check to a known set of historical appTags (e.g. an `APP_TAGS_HISTORICAL` env list the scope ORs over) so a `pevotest` paper still matches after the flip. Bias remains over-inclusive (keep pinned) which is the safe direction for an unpin decision.

## Acceptance

- The flip-day data-loss path is closed by at least the documented drain step, and (if the code path is chosen) the cleanup reference check matches historical-appTag content during a transition.
- No change to steady-state single-appTag behavior.

## Non-goals

- Migrating the published beta corpus itself (re-tagging or re-broadcasting `pevotest` papers under the prod tag) — that is the broader corpus-migration concern, out of scope here.
- Any change to the per-request `cidIsKnown` gateway path (the gateway 404 on a stale-namespace CID is a read miss, not data loss).

## References

- `backend/src/ipfs-cleanup.ts` (`cidReferencedInHaf`, `runCleanup`, `MAX_AGE_MS`)
- `backend/src/config.ts` (`appTag`, `appTagsHistorical`)
- `backend/src/lib/ipfs-shared.ts` (`cidReferencedByAppTag` — the widened containment query)
- `agents/docs/ARCHITECTURE.md` (IPFS cleanup + appTag sections, for the runbook note)

## Backend implementation note (2026-05-27)

**Decision: implemented the code-hardening path (both mitigations land).**

- `config.appTagsHistorical` reads `APP_TAGS_HISTORICAL` (comma-separated,
  trimmed, empties filtered). Empty by default → steady-state single-appTag
  behavior is byte-identical to before (the generated query collapses to the
  single-tag form; covered by the `ipfs-shared-cid-containment.test.ts`
  steady-state case).
- `cidReferencedByAppTag` (the helper extracted in the predecessor
  de-duplication task) now scopes over `[appTag, ...appTagsHistorical]`,
  de-duplicated: one OR'd `c.tags @> $N` containment per tag (each GIN-indexable
  so the planner BitmapOrs index scans — indexed scope preserved) plus one
  ipfs_cid + one supplementary_files namespace containment per tag. The bias
  stays over-inclusive (keep pinned), the safe direction for an unpin decision.
- Both `cidReferencedInHaf` (cleanup unpin decision — the data-loss path this
  task closes) and `cidIsKnown` (gateway) consume the shared helper, so during a
  transition window a historical-tag CID also resolves at the gateway instead of
  404-ing. That is a harmless over-inclusive improvement on the read path; the
  non-goal #2 carve-out (gateway 404 is a read miss, not data loss) is about not
  *requiring* a gateway fix, not forbidding the shared-helper benefit.
- Tests added: `backend/tests/lib/ipfs-shared-cid-containment.test.ts` (SQL-shape
  contract — steady-state single-tag form, historical-tag OR widening across
  tags-scope + namespace, current==historical de-dup, rowCount true/null return).

### [TODO Architect]

Two architect-zone edits remain (both outside the backend zone, so they could
not land in the backend commit):

1. **`agents/docs/ARCHITECTURE.md` — flip-day drain runbook step** (the
   operational floor). Near the IPFS-cleanup / appTag description, add: before
   changing `APP_TAG` to its production value, either (a) drain
   `pending_ipfs_uploads` — hold the flip until the table is empty, or let all
   rows age past the 24h `MAX_AGE` and be reaped by a cleanup sweep so no
   stale-namespace row reaches a post-flip sweep — or (b) set
   `APP_TAGS_HISTORICAL=<old-tag>` (e.g. `pevotest`) before the flip so the
   cleanup reference check still matches old-tag on-chain papers during the
   transition, then clear it once the old-tag pending rows have drained. The
   drain is the floor; the env var is the in-code belt-and-suspenders.

2. **`.env.example` — document `APP_TAGS_HISTORICAL`.** Near `APP_TAG=pevo`
   (line ~13), add a commented entry, e.g.:
   `# Comma-separated prior APP_TAG values during a beta→prod tag flip; OR'd into the IPFS-cleanup reference check so old-tag pinned files are not unpinned. Empty in steady state.`
   then `APP_TAGS_HISTORICAL=`. The config reader already defaults to empty, so
   this is documentation only — no behavioral dependency on the entry.

## Architect review (2026-05-27) — PARKED, premise rejected (review → blocked)

`/ce-code-review` ran on the widening diff (the commit that added `config.appTagsHistorical` and widened `cidReferencedByAppTag` to OR over `[appTag, ...appTagsHistorical]`). The code is correct and inert by default (empty `APP_TAGS_HISTORICAL`), but a product decision surfaced during triage rejects this task's premise.

**Old-tag content does not need to be served or retained by the production app after an `APP_TAG` flip.** An old-tag corpus may instead live on a separate instance kept on the old tag — but that is not yet decided. This undercuts the feature on both consumer paths: the gateway (`cidIsKnown`) need not serve old-tag CIDs, and the cleanup (`cidReferencedInHaf`) unpinning old-tag files post-flip is therefore acceptable, not data loss. The "must not unpin live pevotest-era files" premise this task was built on does not hold.

**Decision: revert the widening, keep the extraction.** A separate pending task — `backend-revert-apptag-historical-widening` — directs the backend agent to remove `config.appTagsHistorical`, restore `cidReferencedByAppTag` to its single-tag form, and remove the widening-specific test, leaving the de-duplication extraction intact. The review findings against the widening are moot once it is reverted:

- unvalidated `APP_TAGS_HISTORICAL` format (silent zero-match → unpin) — the field is removed;
- the `[TODO Architect]` `.env.example` + `ARCHITECTURE.md` flip-day drain runbook — deliberately NOT written, because it would bake in the still-open serve-old-tags decision;
- the SQL-shape test's thin behavioral coverage of the widening — the test is removed.

[BLOCKED by product decision] Stays blocked pending the decision on whether and how old-tag content is served and retained post-flip (the separate-instance approach). If that decision later calls for a transition-window safety mechanism, re-scope from here rather than restoring the reverted widening verbatim.

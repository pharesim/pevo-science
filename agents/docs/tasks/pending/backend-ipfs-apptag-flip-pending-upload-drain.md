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
- `backend/src/config.ts` (`appTag`)
- `agents/docs/ARCHITECTURE.md` (IPFS cleanup + appTag sections, for the runbook note)

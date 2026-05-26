# UI-DEDUP-AUTHOR-HIVE-ON-REBROADCAST — drop duplicate-hive author entries before broadcasting a revision

**Owner:** UI Agent
**Created:** 2026-05-26 (architect, split from the `ui-author-list-prefill-on-revision` review)
**Priority:** P3

## Problem

When the revision form assembles `allAuthors` for broadcast in `handleSubmit`, it does no client-side dedup by `hive`. Two paths can produce a duplicate entry:

- The prior `authors[]` already contains two entries with the same `hive` (carried forward verbatim from the resolved set into `existingCoAuthors`).
- A new co-author row's `hive` collides with an existing author's `hive`.

The result is a redundant author entry in the broadcast `json_metadata.pevotest.authors`.

## Why this is low priority

The backend re-dedups author entries on read, so display surfaces are unaffected — the only artifact is a redundant entry in the on-chain metadata. The chain is SSoT; the backend dedup is the authority. This is a write-path cleanliness guard, not a correctness fix.

## Goal

Before broadcasting, drop author entries whose normalized `hive` duplicates an earlier entry (keep first occurrence; preserve order). Hive-less entries (`hive: null`) are never deduped against each other.

## Acceptance

- A prior author set with a duplicated `hive` broadcasts a single entry for that account.
- A new co-author whose `hive` matches an existing author does not add a second entry.
- Hive-less (`hive: null`) display-only credits are all preserved (not collapsed together).
- Author order is preserved (first occurrence wins).
- Unit test covering both duplicate sources.

## Cross-references

- `agents/docs/ARCHITECTURE.md` § 2 "Multi-Author Trust Model" — additions allowed, removals only via `author_resign`.
- Backend read-time dedup is the authority; this is a write-path cleanliness guard only.

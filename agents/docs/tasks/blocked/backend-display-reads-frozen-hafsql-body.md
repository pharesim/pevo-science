# Listing, profile, search, review and comment readers show the creation body of an edited post

**Owner:** backend
**Created:** 2026-10-01

## Why

`hafsql.comments.body` never takes an edit: HafSQL's sync swaps its arguments when it applies
one, so the column keeps the creation body while `title`, `json_metadata` and `last_edited`
follow the latest op (`agents/docs/ARCHITECTURE.md` § 2 "Body, edits and versions"). The paper
detail is moved to the replayed body by
`backend-paper-body-from-replay-and-head-endpoint`. These readers still present the column as
the current body:

- `backend/src/routes/papers.ts`, the listing: `LEFT(c.body, 300) AS abstract`.
- `backend/src/routes/profile.ts`: `LEFT(c.body, 300) AS body`, three sites.
- `backend/src/routes/search.ts`: `c.body ILIKE ...` in both match arms, and the snippet
  `substring(c.body from 1 for 300)`. After an edit that removes a claim, a search for the removed
  wording still finds the paper and a search for the new wording misses it.
- `backend/src/routes/reviews.ts` and `backend/src/routes/comments.ts` (three arms): review and
  comment bodies. Out-of-band edits happen (3 of 200 sampled pevotest replies had more than one
  op), and a review's rating, read from the latest `json_metadata`, can then disagree with its
  text.

For a chain paper the listing, profile and search rows also come from the root post, not the
head, so they show the root's text even where the detail shows the head's.

SEO meta is not affected: `injectPaperMeta` in `backend/src/app.ts` reads `get_content`.

## Scope

Make every reader above present the replayed current body (for a chain paper, the head's), with
a mechanism chosen here. The replay is per post; candidates the architect review weighed: a
replay cache keyed on `(author, permlink, last_edited)` (`last_edited` does follow edits) with a
finite TTL and never filled from a failed replay, post-processing the listing and profile rows;
for search, filtering candidates in JS over replayed bodies, or recording "search matches the
creation body" as a documented limit. Propose, measure the listing cost (rows per page, ops per
post) against the HAF node, and say which you chose in the signal block.

## [BLOCKED by Architect] (2026-10-01) — waiting on the upstream report

The user is reporting the HafSQL defect to the node operator. If it is fixed upstream and the
column is re-synced, most of this task becomes unnecessary (the chain-paper head case remains).
The architect moves this file to `pending/` with the outcome, or with a decision to proceed
regardless.

### Status (2026-10-05): fixed upstream, not yet deployed on our node

- HafSQL v2.6.2 (2026-10-02) swaps the two variables in `updateEditedComment`
  (`7997db2c`, "fix: comment body was never edited"). Its upgrade step, for any node coming
  from 2.6.1 or earlier, drops `hafsql.comments_table` and re-syncs comments, deletions and
  rewards from block 0, so existing rows get rebuilt. v2.6.3 (2026-10-03) also strips 0x00
  from titles and bodies.
- The node in `HAF_DATABASE_URL` still reports `hafsql.version` 2.5.0, and `comments_table`
  has not been rebuilt. Edits made within the hour before 04:24 UTC still freeze (9 of 9
  sampled posts hold the creation body), and so do the report's examples.
- When the node upgrades, `hafsql.comments` is incomplete until the comments re-sync catches
  up, and every PEvO reader of that view (listings, profiles, search, paper detail, reviews,
  comments) sees partial data meanwhile. The re-sync duration is unknown.

Still blocked: wait for the deploy and the re-sync, then re-run the sweep in the
`hafsql-comments-body-never-follows-an-edit-read-the-replay` learning to confirm.

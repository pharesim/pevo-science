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

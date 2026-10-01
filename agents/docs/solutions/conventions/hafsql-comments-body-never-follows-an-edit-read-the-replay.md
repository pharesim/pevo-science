---
title: "hafsql.comments.body never follows an edit: read the comment-op replay for any post whose last_edited is set"
date: 2026-10-01
category: conventions
module: backend/src/routes/papers.ts + backend/src/lib/chain-walkers.ts
problem_type: convention
component: database
severity: high
applies_when:
  - "Reading a post or comment body from hafsql.comments (c.body) for display, an edit-form prefill, a patch diff base, a listing abstract, a search match or a snippet"
  - "Adding or reviewing a HAF query that selects a body column for a post that may have been edited"
  - "Triaging a report that an edit 'did not save' or that the default page and ?version=<latest> show different bodies"
  - "Deciding whether sending a full body instead of an @@ patch fixes what the paper page shows (it does not)"
symptoms:
  - "The default paper detail body is the creation body while ?version=<latest> and condenser_api.get_content return the edited text"
  - "hafsql.comments.last_edited, title and json_metadata move on an edit while body stays at the creation body"
  - "The edit page prefills and diffs against text the chain no longer holds, so a re-typed edit applies twice"
  - "Listing abstracts, profile snippets and search matches read the frozen creation body for edited posts"
root_cause: data_integrity
resolution_type: documentation_update
related_components:
  - version-chain
  - paper-detail
  - edit-flow
tags:
  - haf
  - hafsql
  - comment-body
  - upstream-defect
  - hive-native-edit
  - patch-replay
  - paper-edit
  - silent-wrong-output
---

# `hafsql.comments.body` is the creation body, not the current body, on any edited post

`hafsql.comments.body` never follows an edit. On every post whose `last_edited` is not null it
holds the body of the post's first `comment` op, while `title`, `json_metadata` and
`last_edited` on the same row follow the latest op. Never present that column as the current
body of a post that may have been edited. The current body is the replay of the post's
`comment` ops in block order (`hafsql.operation_comment_view`, replayed by
`reconstructVersionsFromHaf` in `backend/src/lib/chain-walkers.ts`), which is what
`condenser_api.get_content` and `bridge.get_post` serve. The column may stand for the current
body only when `last_edited IS NULL`.

## Context

The defect is upstream, in HafSQL's sync, on a node PEvO does not operate and whose code and
indexes PEvO cannot change. Per the 2026-10-01 investigation, `updateEditedComment` in HafSQL's
`src/app/sync/comments.ts` (gitlab.com/mahdiyari/hafsql and the openhive-network mirror,
unchanged from 2024-10 through v2.6.1, released 2026-08-13) assigns the incoming op body to a
variable named `oldBody` and the stored body to one named `newBody`, then calls
`patchBody(oldBody, newBody)`. `patchBody` runs `patch_fromText` on the stored body, which is
ordinary prose, so it throws "Invalid patch string", and its `catch` returns the stored body,
which is written back. Title, metadata and `last_edited` are set from the op in the same
function, so the row ends up mixed: new title, new metadata, new `last_edited`, creation body.

What that code does, as reproduced in a probe of it:

- A patch (`@@`) edit: body unchanged.
- A full-body edit: body unchanged as well. Sending the whole body instead of a patch does not
  get around it.
- Only an empty stored body gets replaced.
- A creation body that itself parses as a patch gets that patch applied to the incoming op (the
  one outlier in the samples).

Per the 2026-09-30 and 2026-10-01 measurements on the configured HAF node (read-only): of 30
posts edited with differing full bodies, the column equalled the creation op in 29 and the
latest op in none, while `get_content` equalled the latest in all 30. Across 40 patched posts the
column matched hivemind's body 0 times and PEvO's walker replay matched 40 times. `title` (2 of
2), `json_metadata` (20 of 20) and `last_edited` (30 of 30) followed the latest op.
`hafsql.comments` is a view over the table `hafsql.comments_table`; the defect is in what the
sync writes, so no query shape over the view recovers the edited body.

PEvO's one edited paper shows it end to end:
`pevo.science/pevo-original-whitepaper-2016-2026-revision-mnczwwdm` has a creation op and one
`@@` patch op (2026-04-03). The column holds 13711 characters (the creation op); `get_content`
and the replay both hold 13523. The default paper page has served the 13711-character body since
April: the edit has never been visible on PEvO's default view.

Where PEvO reads the column in the current tree:

- **Paper detail.** `fetchPaperDetailFromHaf` in `backend/src/routes/papers.ts` selects `c.body`
  from `T.comments` and swaps in the latest replayed version only inside its
  `if (chain.length > 1)` continuation-chain branch. Every PEvO paper is a single post (as of
  2026-10-01), so the detail always serves the creation body.
- **Edit page diff base.** `_prefillForm` in `frontend/src/pages/edit.js` fills the form from that
  detail body and sets `_originalBody` from it; the broadcast builds its patch with
  `computeDiff(this._originalBody, newPostBody)`. Every patch broadcast after the first edit is
  therefore a patch against text the chain no longer holds, which hivemind applies fuzzily over the edited body (an
  author who re-types the "missing" change gets it twice).
- **Listing.** `LEFT(c.body, 300) AS abstract` in `fetchPapersFromHaf` (`papers.ts`).
- **Profile.** `LEFT(c.body, 300) AS body`, three sites in `backend/src/routes/profile.ts`.
- **Search.** `c.body ILIKE` in both match arms of `backend/src/routes/search.ts` and the
  `substring(c.body from 1 for 300)` snippet: a search for removed wording still matches, and a
  search for the new wording misses.
- **Reviews and comments.** `backend/src/routes/reviews.ts`, `backend/src/routes/comments.ts`
  (three body reads: the two `comment_tree` arms and the outer select) and `fetchEnrichmentFromHaf` in `papers.ts` (the review set on the paper page). A
  review's rating comes from its latest `json_metadata` while its text is the creation body, so
  the two can disagree after an edit (per the measurement, 3 of 200 sampled pevotest replies had
  more than one op).

Not affected: `injectPaperMeta` in `backend/src/app.ts` and the blog route in
`backend/src/routes/blog.ts`, which read through the Hive API.

**Status, pending as of 2026-10-01.** The rule is recorded in `agents/docs/ARCHITECTURE.md` § 2
"Body, edits and versions", which describes the target; the code does not meet it yet. A backend task
moves the paper detail to the replay, and a second one, held until the user's upstream report to the
HafSQL operator is answered, covers the other readers. Neither is implemented. When either lands, this
paragraph and the reader list above need a `/ce-compound-refresh`.

## Guidance

**Which `hafsql.comments` (`T.comments` in `backend/src/hafsql.ts`) columns a new query may read
as current:**

| Column | Safe as the current value? |
| --- | --- |
| `title`, `json_metadata`, `last_edited` | Yes. Measured to follow the latest op. |
| `author`, `permlink`, `parent_author`, `parent_permlink`, `created` | Yes. Identity and creation facts; an edit cannot change them. |
| `body` in a select list | Only on a row with `last_edited IS NULL`. On any other row it is the creation body. |
| `body` in a predicate (`ILIKE`, full text) or an excerpt (`LEFT`, `substring`, `length`) | Same restriction: it matches, excerpts and measures the creation body. |
| `tags`, `root_author`, `root_permlink` | Not measured, and PEvO reads none of them from this view. Read tags from `json_metadata`. |

**How to get the current body:**

1. Replay `hafsql.operation_comment_view` for the `(author, permlink)` in `block_num` order, as
   `reconstructVersionsFromHaf` does: a body that starts with `@@` is a `diff-match-patch` patch
   applied to the previous body, fuzzily and ignoring the per-hunk success flags (per the
   investigation, this is how hivemind's `_merge_post_body` applies it); any other body replaces
   the previous one. The last version's body is the current body.
2. Or ask a Hive API node (`condenser_api.get_content`, `bridge.get_post`) when one post's body is
   needed and an API round trip is acceptable.
3. Use `c.body` only as a stand-in when the replay is empty AND `c.last_edited IS NULL`. For an
   edited post whose replay failed, the answer is an error (the pending detail task makes it a
   retriable 503), not a fallback to the column, and the result must not be stable-cached.

**Two replay pitfalls in the current tree:**

- `applyHivePatch` in `chain-walkers.ts` calls `dmp.patch_fromText` with no catch. A body that
  starts with `@@` but does not parse throws, and the outer catch in `reconstructVersionsFromHaf`
  returns `[]` for the whole chain, emptying the paper's history. hivemind treats such a body as
  a full replacement; the pending detail task makes `applyHivePatch` do the same.
- `last_edited` does follow edits, so it is a usable component of a cache key for a replayed body
  (`(author, permlink, last_edited)`). It never makes the column's body current.

**What did not work during the investigation; do not repeat it:**

- Treating the stale edit-page diff base as a 30-minute detail-cache window or a retry artefact.
  The column is frozen permanently; the problem is cache-independent and clearing caches changes
  nothing.
- "A full-body edit resets the column." Refuted on 30 full-body-edited posts: HafSQL ignores
  full-body edits too, so switching the composer to full-body ops does not fix what PEvO
  displays for a single-post paper. Only reading the replay does.
- "The column equals the last full-body op." True only on samples where the creation op was the
  only full-body op. Separated, the samples show it is the creation op every time.

## Why This Matters

The paper body is what readers cite and reviewers assess. With the column as the source, an
author's correction never appears on PEvO although every other Hive frontend shows it, a
reviewer assesses text the author has already changed, and the edit page builds each new patch
against a stale base, so the chain's copy drifts further from what the author sees. The failure
is silent: there is no error, the row looks fresh because `title` and `last_edited` did update,
and it only surfaces when someone compares against another frontend. It also inverts PEvO's own
stance that the chain is the source of truth and HAF reads are a performance layer: the chain
holds the edit; only the index lost it.

The defect is on a third-party node, and an upstream fix only helps once the column is re-synced,
which PEvO cannot verify for every row. The replay is correct whatever HafSQL stores, so the
paper detail moves to it regardless of the upstream outcome; for the other readers the decision
waits on that outcome.

## When to Apply

- Writing or reviewing any SQL that touches `body` from `hafsql.comments` / `T.comments`: select
  lists, snippets, `ILIKE` or search predicates, length checks.
- Any surface that shows or diffs a post's text: paper detail, edit-page prefill and diff base,
  listings, profile cards, search, reviews, comments.
- Investigating "my edit does not show", "search finds text I removed", "the review text and its
  rating disagree", or any mismatch between PEvO and another Hive frontend.
- Checking whether the upstream fix has landed and the column was re-synced (rerun the sweep in
  Examples).

## Examples

**Detection for one post** (read-only; bind `$1`, `$2` to the author and permlink). If
`column_equals_creation_op` is true and `op_count` is above 1, the column is frozen:

```sql
WITH ops AS (
  SELECT co.body,
         ROW_NUMBER() OVER (ORDER BY co.block_num) AS n,
         COUNT(*)     OVER ()                      AS total
  FROM hafsql.operation_comment_view co
  WHERE co.author = $1 AND co.permlink = $2
)
SELECT c.last_edited,
       length(c.body)                                         AS column_len,
       (SELECT length(body) FROM ops WHERE n = 1)             AS creation_op_len,
       (SELECT left(body, 2) = '@@' FROM ops WHERE n = total) AS latest_op_is_patch,
       c.body = (SELECT body FROM ops WHERE n = 1)            AS column_equals_creation_op,
       (SELECT count(*) FROM ops)                             AS op_count
FROM hafsql.comments c
WHERE c.author = $1 AND c.permlink = $2
  AND c.last_edited IS NOT NULL;
```

On 2026-10-01, for the whitepaper post, it returned `column_len` 13711, `creation_op_len` 13711,
`latest_op_is_patch` true, `column_equals_creation_op` true, `op_count` 2, in about 100 ms.

**Sweep of every edited PEvO paper** (bind `$1` to `APP_TAG`, `pevotest` in the beta). Rows with
`column_is_creation_body` true are frozen; when the latest op is a full body,
`column_is_latest_op_body` false confirms it without a replay:

```sql
SELECT c.author, c.permlink, c.last_edited,
       c.body = first_op.body       AS column_is_creation_body,
       c.body = last_op.body        AS column_is_latest_op_body,
       left(last_op.body, 2) = '@@' AS latest_op_is_patch
FROM hafsql.comments c
CROSS JOIN LATERAL (
  SELECT co.body FROM hafsql.operation_comment_view co
  WHERE co.author = c.author AND co.permlink = c.permlink
  ORDER BY co.block_num ASC LIMIT 1) first_op
CROSS JOIN LATERAL (
  SELECT co.body FROM hafsql.operation_comment_view co
  WHERE co.author = c.author AND co.permlink = c.permlink
  ORDER BY co.block_num DESC LIMIT 1) last_op
WHERE c.parent_author = '' AND c.parent_permlink = $1
  AND c.last_edited IS NOT NULL
ORDER BY c.last_edited DESC
LIMIT 20;
```

On 2026-10-01 it returned one row (the whitepaper, `column_is_creation_body` true) in about 60 ms.

Run either from Node with `pg` loaded through `createRequire` on the repo's
`backend/package.json` (absolute path) and `HAF_DATABASE_URL` read from the repo-root `.env`. Do not print the URL, and do not pass a `statement_timeout` startup parameter (the
pooler rejects it).

**Cross-check against hivemind for a patched post**, where SQL alone cannot produce the latest
body: replay the ops and compare with `get_content`.

```js
// dmp = new diff_match_patch() from the backend's diff-match-patch dependency
const ops = (await client.query(
  `SELECT body FROM hafsql.operation_comment_view
   WHERE author = $1 AND permlink = $2 ORDER BY block_num`, [A, P])).rows;
let body = '';
for (const o of ops) {
  body = o.body.startsWith('@@') ? dmp.patch_apply(dmp.patch_fromText(o.body), body)[0] : o.body;
}
// condenser_api.get_content [A, P] on a public node: result.body === body       -> true
// SELECT body FROM hafsql.comments for the pair:     column === result.body     -> false
```

For the whitepaper post on 2026-10-01: replay 13523 characters, `get_content` 13523 and equal,
column 13711 and not equal.

**Through PEvO's own API:** compare `GET /api/papers/<author>/<permlink>` with
`GET /api/papers/<author>/<permlink>?version=<latest version_number>`. The `?version=N` branch of
the detail route reads `reconstructVersionsFromHaf`; the default detail reads the column for a
single-post paper. Differing bodies is this defect (and once the pending detail task lands, the two
must agree). The signature at a glance: `last_edited` moves while `body` stays put.

**Prevention for a new reader.** Read only edit-safe columns from `T.comments`; take the text from
the replay, or gate the column on `last_edited`:

```sql
-- Wrong: presents the creation body of an edited post as current.
SELECT c.author, c.permlink, c.title, LEFT(c.body, 300) AS abstract
FROM hafsql.comments c ...

-- Right: the column only where the post was never edited; every row with a NULL
-- abstract_if_unedited gets its text from the replay (reconstructVersionsFromHaf)
-- or from a cache keyed on (author, permlink, last_edited) that a failed replay never fills.
SELECT c.author, c.permlink, c.title, c.json_metadata, c.last_edited,
       CASE WHEN c.last_edited IS NULL THEN LEFT(c.body, 300) END AS abstract_if_unedited
FROM hafsql.comments c ...
```

A search predicate has no such gate: `c.body ILIKE` always searches the creation body of an edited
post. Either filter over replayed bodies or record "search matches the creation body" as a
documented limit; the blocked readers task leaves that choice open.

## Related

- `agents/docs/ARCHITECTURE.md` § 2 "Body, edits and versions": the normative rule this entry explains.
- [pevo-paper-version-chain-and-edit-semantics-2026-04-30.md](../architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md): the version chain this replay builds; its "pre-fill from the chain head" statements do not hold for a single-post paper until the detail reads the replay.
- [json-metadata-raw-map-use-safepevometa-2026-06-06.md](json-metadata-raw-map-use-safepevometa-2026-06-06.md): the same silent-wrong-output class on chain-derived data. `json_metadata` on the same `hafsql.comments` row does follow edits.
- [fail-closed-vs-degrade-accepted-haf-error-boundary-2026-06-11.md](fail-closed-vs-degrade-accepted-haf-error-boundary-2026-06-11.md): why a failed replay on an authoritative read is an error, not a fallback to the column.

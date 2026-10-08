---
title: "hafsql.comments.body follows edits only from HafSQL v2.6.2: check the node's version before reading it as the current body"
date: 2026-10-09
category: conventions
module: backend/src/routes/papers.ts + backend/src/lib/chain-walkers.ts
problem_type: convention
component: database
severity: medium
applies_when:
  - "Pointing PEvO or an AGPL fork at a HAF node, or checking which HafSQL version the configured node runs"
  - "Writing or reviewing SQL that reads body from hafsql.comments in a select list, a snippet, an ILIKE predicate or a length check"
  - "Triaging a report that an edit does not show, or that the default paper page and ?version=<latest> show different bodies"
  - "A HAF node operator upgrades HafSQL from 2.6.1 or earlier, so hafsql.comments re-syncs from block 0"
  - "Deciding where PEvO takes a post's current body from: the column, the comment-op replay or a Hive API node"
symptoms:
  - "On HafSQL 2.6.1 or earlier, hafsql.comments.body stays at the creation body while title, json_metadata and last_edited follow the latest op"
  - "The default paper detail and ?version=<latest> or condenser_api.get_content show different bodies for an edited post"
  - "Listings, profiles, search and paper pages are partial while an upgraded node re-syncs hafsql.comments from block 0"
  - "On HafSQL 2.6.3 or later, the column differs from get_content for a post containing the literal text u0000"
root_cause: data_integrity
resolution_type: documentation_update
related_components:
  - version-chain
  - paper-detail
  - edit-flow
tags:
  - haf
  - hafsql
  - hafsql-version
  - comment-body
  - upstream-defect
  - hive-native-edit
  - patch-replay
  - paper-edit
supersedes:
  - hafsql-comments-body-never-follows-an-edit-read-the-replay.md
---

# `hafsql.comments.body` follows edits only from HafSQL v2.6.2

On a node running HafSQL 2.6.2 or later, with its comments re-sync complete, `hafsql.comments.body`
is the current body of an edited post and may be read as such. On HafSQL 2.6.1 or earlier it is
the creation body of every edited post, while `title`, `json_metadata` and `last_edited` on the
same row follow the latest op. The node PEvO is configured against runs 2.6.3 (confirmed
2026-10-08). The node's version is recorded in `hafsql.version`; check it before trusting the
column on any other node.

## Context

HafSQL is the indexer on the HAF node PEvO queries. A third party operates it, and PEvO cannot
change its code or indexes. Its source is gitlab.com/mahdiyari/hafsql, with a mirror under
openhive-network. Every path in this entry that starts with src/ is in that repository, not in PEvO.
`hafsql.comments` is a view over the table `hafsql.comments_table`, which HafSQL's sync writes.
Each later `comment` op on an existing `(author, permlink)` goes through `updateEditedComment`
in HafSQL's `src/app/sync/comments.ts`.

**HafSQL 2.6.2, released 2026-10-02 ("fix: comment body was never edited").** It swaps two
assignments in `updateEditedComment`: `oldBody` is now the stored body and `newBody` the incoming
op body, and the function calls `patchBody(oldBody, newBody)`. A patch op parses and is applied
to the stored body. A full-body op throws in `patch_fromText`, and the catch returns it as the
replacement. The guard kept its old shape, `if (oldBody.length > 0 && oldBody !== newBody)`, so
it now tests the stored body. A row whose stored body is empty therefore never takes an edit.

**The upgrade step.** `handleUpgrade` in HafSQL's `src/upgrade.ts` reads the recorded version
from `hafsql.version` (row `name = 'hafsql'`) and updates it on every version change. That row
is the authoritative record of what the node runs. When the recorded version is 2.6.1 or
earlier, the upgrade drops `hafsql.comments_table` CASCADE. It resets `hafsql.sync_data`'s
`last_block_num` to 0 for comments, delete_comments, paid_rewards and pending_rewards, and the
sync rebuilds from block 0. Until it catches up, `hafsql.comments` is incomplete. Every PEvO
reader of the view sees partial data: listing, profile, search, paper detail, reviews and
comments. How long the re-sync takes was not measured.

**HafSQL 2.6.3, released 2026-10-03.** Titles and bodies pass through `cleanString` (HafSQL's
`src/app/helpers/utils/clean_string.ts`) on insert and on edit. It drops char code 0, then
applies `.replace(/u0000/g, '')`. That pattern also removes the literal five-character text
`u0000`, not only an escaped NUL.

**The configured node, verified 2026-10-08 23:43 UTC** (`HAF_DATABASE_URL`, read-only):

- `hafsql.version` is 2.6.3.
- The comments row of `hafsql.sync_data` has `last_block_num` equal to the chain head (110607682).
- `hafsql.comments_table` was rebuilt (its `pg_stat` last autoanalyze is 2026-10-04).
- Ten root posts edited in the preceding hour, ten distinct authors, eight of them edited with a
  patch op: the column equalled `condenser_api.get_content` in 10 of 10. Two of those edits did
  not change the text, so their column also equals the creation op.
- PEvO's whitepaper, `pevo.science/pevo-original-whitepaper-2016-2026-revision-mnczwwdm`, has a
  column of 13523 characters, the edited body. Before the upgrade it held 13711, the creation op.
- `erikah/which-one-would-you-go-for` (a full body, then one `@@` patch) and
  `creativemary/a-metaphor-for-beauty` (full-body edits, edited again 2026-10-07) both equal
  their current body.
- On 2026-10-09 the PEvO sweep query in Examples returned one row, the whitepaper, with
  `column_is_creation_body` false.

### History: HafSQL 2.6.1 and earlier

The sync code was unchanged from 2024-10 through v2.6.1 (released 2026-08-13).
`updateEditedComment` assigned the incoming op body to `oldBody` and the stored body to
`newBody`, then called `patchBody(oldBody, newBody)`. That ran `patch_fromText` on the stored
body, which is ordinary prose, so it threw "Invalid patch string". The catch returned the stored
body, which was written back. Title, metadata and `last_edited` were set from the op in the same
function. The row ended up mixed: new title, new metadata, new `last_edited`, creation body.

- A patch (`@@`) edit left the body unchanged.
- A full-body edit left it unchanged too.
- Only an empty stored body got replaced.
- A creation body that itself parses as a patch got that patch applied to the incoming op.

Measurements on the same node before the upgrade, 2026-09-30 and 2026-10-01:

- Of 30 posts with differing full-body edits, the column equalled the creation op in 29 and the
  latest op in none. The exception's creation body parses as a patch.
- Across 40 patched posts, the column matched hivemind's body 0 times. PEvO's walker replay
  matched it 40 times.
- 20 posts sampled across 20 authors on 2026-10-01: column equal to the creation op in 20 of 20.
- `title`, `json_metadata` and `last_edited` followed the latest op throughout.
- The whitepaper's edit (2026-04-03) was invisible on PEvO's default paper page until the node
  upgraded.

What did not work on a 2.6.1-or-earlier node:

- Sending full-body edits instead of `@@` patches. HafSQL ignored those as well, so switching the
  composer to full-body ops does not change what the column holds.
- Clearing PEvO's caches. The column itself was wrong, so the problem was cache-independent.
- Reading "the column equals the last full-body op" from samples. That held only where the
  creation op was the only full-body op. Separated, the samples show the creation op every time.

## Guidance

**Know the node before trusting the column.** Read `hafsql.version` and compare the comments row
of `hafsql.sync_data` with the chain head (queries in Examples):

| Node state | What `hafsql.comments.body` is |
| --- | --- |
| 2.6.2 or later, comments sync at the chain head | The current body of every post, subject to the residual differences listed in this section. |
| 2.6.2 or later, comments sync behind the head | Correct where a row exists, but rows are missing. Every reader of the view returns partial data. |
| 2.6.1 or earlier | The creation body of every post whose `last_edited` is not null. Read it as current only where `last_edited IS NULL`. |

**Which `hafsql.comments` columns (`T.comments` in `backend/src/hafsql.ts`) a query may read as
current:**

| Column | Safe as the current value? |
| --- | --- |
| `title`, `json_metadata`, `last_edited` | Yes on every version measured. Titles pass through `cleanString` from 2.6.3. |
| `author`, `permlink`, `parent_author`, `parent_permlink`, `created` | Yes. Identity and creation facts that an edit cannot change. |
| `body`, in a select list, a predicate or an excerpt | Per the node-state table in this section. |
| `tags`, `root_author`, `root_permlink` | Not measured, and PEvO reads none of them from this view. Read tags from `json_metadata`. |

**Residual differences between the column and the chain on a fixed node:**

- `cleanString` (2.6.3 and later) drops NUL characters and the literal text `u0000` from titles
  and bodies. For a post containing the literal text `u0000`, the column differs from
  `get_content` and from PEvO's replay, and a search for `u0000` cannot match it. Whether a NUL
  ever reaches the chain-side copies is not measured.
- The stored-empty guard (2.6.2 and later): a row whose stored body is empty never takes an edit,
  so its column stays empty while the chain holds the edited body. This is a code-reading fact;
  how often a stored body is empty on Hive is not measured.
- JavaScript `diff-match-patch` counts patch offsets in UTF-16 code units. hivemind's Python port
  counts code points. After many characters outside the Basic Multilingual Plane, a patch can
  apply differently in hivemind than in the HafSQL column or PEvO's replay, which are both
  JavaScript. This is not a HafSQL defect.

**Where PEvO still replays, and why.** `agents/docs/ARCHITECTURE.md` § 2 "Body, edits and
versions" records the decision. The paper detail takes its body from the replay of the post's
`comment` ops (`reconstructVersionsFromHaf` in `backend/src/lib/chain-walkers.ts`). It replays
every paper for its `versions[]` and its head marker anyway, and one source keeps body, versions
and marker consistent within a fill. The current code does not fully meet that yet:

- `fetchPaperDetailFromHaf` in `backend/src/routes/papers.ts` selects `c.body` from `T.comments`.
  It swaps in the latest replayed version only inside its `if (chain.length > 1)` branch. Today a
  single-post paper's detail therefore serves the column, which is correct on a fixed node.
- Pending as of 2026-10-09: a backend change makes the detail take body, title and
  `json_metadata` from the replay for every paper.

The other readers take the column, which is correct on a fixed node for an edited post:

- Listing: `LEFT(c.body, 300) AS abstract` in `fetchPapersFromHaf` (`backend/src/routes/papers.ts`).
- Profile: the `LEFT(c.body, 300)` reads in `backend/src/routes/profile.ts`.
- Search: `c.body ILIKE` and the `substring(c.body from 1 for 300)` snippet in
  `backend/src/routes/search.ts`.
- Reviews and comments: `backend/src/routes/reviews.ts`, `backend/src/routes/comments.ts`, and
  `fetchEnrichmentFromHaf` in `backend/src/routes/papers.ts`.

The listing, profile and search readers read the root post's row. For a paper with continuations
they show the root's title and text, not the head's. Pending as of 2026-10-09: a separate backend
change addresses that.

**Two replay pitfalls in the current tree:**

- `applyHivePatch` in `backend/src/lib/chain-walkers.ts` calls `dmp.patch_fromText` with no
  catch. A body that starts with `@@` but does not parse throws. The outer catch in
  `reconstructVersionsFromHaf` then returns `[]` for the whole chain, emptying the paper's
  history. hivemind treats such a body as a replacement, and so does HafSQL 2.6.2 and later.
  Pending as of 2026-10-09: the backend change that moves the detail to the replay makes `applyHivePatch` do so too.
- `last_edited` follows edits on every version, so `(author, permlink, last_edited)` is a usable
  cache key for a replayed body. On 2.6.1 or earlier it never makes the column's body current.

## Why This Matters

The paper body is what readers cite and reviewers assess. On a 2.6.1-or-earlier node an author's
correction never appears on PEvO, although every other Hive frontend shows it. A reviewer
assesses text the author already changed. The edit page fills its diff base from the detail body
(`_prefillForm` and `_originalBody` in `frontend/src/pages/edit.js`), so each new patch is built
against text the chain no longer holds. The failure is silent: `title` and `last_edited` did
update, so the row looks fresh.

The chain is PEvO's source of truth, and HAF reads are a performance layer over it. Whether that
layer is faithful for bodies depends on a version PEvO does not control. A fork pointed at an
older node, or the configured node mid-upgrade, gets wrong or partial data with no error. The
version check costs one query.

The residual differences explain small mismatches against `get_content` on a fixed node. Treat
them as known limits, not as a return of the old defect.

## When to Apply

- Pointing PEvO or a fork at a HAF node, or after the operator announces a HafSQL upgrade.
- Writing or reviewing SQL that touches `body` from `hafsql.comments` / `T.comments`: select
  lists, snippets, `ILIKE` or search predicates, length checks.
- Triaging "my edit does not show", "search finds text I removed", or any body mismatch between
  PEvO and another Hive frontend. Check the node's version first.
- Papers, profiles or search results missing right after an upgrade from 2.6.1 or earlier. Check
  the comments row of `hafsql.sync_data` against the chain head before suspecting PEvO.
- Changing where the paper detail takes its body: keep it consistent with the § 2 decision.

## Examples

**Version and sync state.** Compare `last_block_num` on the comments row with the chain head
(`head_block_number` from `condenser_api.get_dynamic_global_properties`):

```sql
SELECT version FROM hafsql.version WHERE name = 'hafsql';
SELECT * FROM hafsql.sync_data;
```

On 2026-10-08 the first returned 2.6.3, and the comments row stood at the chain head, 110607682.

**Detection for one post** (read-only; bind `$1`, `$2` to the author and permlink):

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

Reading it: on a fixed node, an edited post whose text changed gives `column_equals_creation_op`
false. True with `op_count` above 1 is the 2.6.1-or-earlier signature, unless the edits left the
text unchanged. For the whitepaper on 2026-10-01 it returned `column_len` 13711, `creation_op_len`
13711, `latest_op_is_patch` true, `column_equals_creation_op` true and `op_count` 2. On the fixed
node the column holds 13523 characters, so the lengths differ and the equality is false.

**Sweep of every edited PEvO paper** (bind `$1` to `APP_TAG`, `pevotest` in the beta):

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

Reading it on a fixed node:

- `column_is_creation_body` is false for an edited post whose text changed.
- When the latest op is a full body, `column_is_latest_op_body` is true.
- When the latest op is a patch, `column_is_latest_op_body` is false by construction. Compare the
  column with `get_content` or the replay instead (the hivemind cross-check in these Examples).

On 2026-10-01 the sweep returned one row, the whitepaper, with `column_is_creation_body` true. On
2026-10-09 it returned the same row with `column_is_creation_body` false.

Run these from Node, with `pg` loaded through `createRequire` on the repo's `backend/package.json`
(absolute path) and `HAF_DATABASE_URL` read from the repo-root `.env`. Do not print the URL. Do
not pass a `statement_timeout` startup parameter: the pooler rejects it.

**Cross-check against hivemind for a patched post**, where SQL alone cannot produce the latest
body. Replay the ops the way hivemind applies them and compare with `get_content`:

```js
// dmp = new diff_match_patch() from the backend's diff-match-patch dependency
const ops = (await client.query(
  `SELECT body FROM hafsql.operation_comment_view
   WHERE author = $1 AND permlink = $2 ORDER BY block_num`, [A, P])).rows;
let body = '';
for (const o of ops) {
  if (!o.body.startsWith('@@')) { body = o.body; continue; }
  try { body = dmp.patch_apply(dmp.patch_fromText(o.body), body)[0]; }
  catch { body = o.body; } // an unparseable @@ body replaces, as in hivemind
}
// condenser_api.get_content [A, P] on a public node: result.body === body
// SELECT body FROM hafsql.comments for the pair:  column === result.body
//   true on a fixed node (barring the residual differences), false on 2.6.1 or earlier
```

For the whitepaper on 2026-10-01: replay 13523 characters, `get_content` 13523 and equal, column
13711 and not equal. On 2026-10-08 the column was 13523 as well.

**Through PEvO's own API.** Compare `GET /api/papers/<author>/<permlink>` with
`GET /api/papers/<author>/<permlink>?version=<latest version_number>`. The `?version=N` branch of
the detail route reads `reconstructVersionsFromHaf`. Today the default detail reads the column for
a single-post paper. On a fixed node the two agree. On 2.6.1 or earlier they differ for an edited
paper: `last_edited` moves while `body` stays put. Once the pending detail change lands they agree
on any node.

**A new reader on a node that may run 2.6.1 or earlier** (a fork, or before checking the
version). Gate the column on `last_edited`, and take an edited post's text from the replay:

```sql
-- Wrong on 2.6.1 or earlier: presents the creation body of an edited post as current.
SELECT c.author, c.permlink, c.title, LEFT(c.body, 300) AS abstract
FROM hafsql.comments c ...

-- Safe on any version: the column only where the post was never edited. A row with a NULL
-- abstract_if_unedited gets its text from reconstructVersionsFromHaf, or from a cache keyed
-- on (author, permlink, last_edited) that a failed replay never fills.
SELECT c.author, c.permlink, c.title, c.json_metadata, c.last_edited,
       CASE WHEN c.last_edited IS NULL THEN LEFT(c.body, 300) END AS abstract_if_unedited
FROM hafsql.comments c ...
```

A search predicate has no such gate: on 2.6.1 or earlier, `c.body ILIKE` searches the creation
body of an edited post.

## Related

- [ARCHITECTURE.md § 2 "Body, edits and versions"](../../ARCHITECTURE.md): the normative record
  of the replay rule, the v2.6.2 confirmation and the detail's decision to keep replaying.
- [pevo-paper-version-chain-and-edit-semantics-2026-04-30.md](../architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md):
  the version chain that the replay builds, which the detail's `versions[]` and head marker come from.
- [json-metadata-raw-map-use-safepevometa-2026-06-06.md](json-metadata-raw-map-use-safepevometa-2026-06-06.md):
  the same silent-wrong-output class on chain-derived data. `json_metadata` on the same
  `hafsql.comments` row follows edits on every HafSQL version measured.
- [fail-closed-vs-degrade-accepted-haf-error-boundary-2026-06-11.md](fail-closed-vs-degrade-accepted-haf-error-boundary-2026-06-11.md):
  why a failed replay on an authoritative read is an error, not a fallback to the column.

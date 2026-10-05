# The paper detail serves the replayed body, and a head endpoint tells the composers what the chain holds now

**Owner:** backend
**Created:** 2026-10-01
**Priority:** normal

Implements the backend half of the composer retry-safety decision. Read
`agents/docs/ARCHITECTURE.md` § 2 "Body, edits and versions" and § 8 "Composer Drafts" first:
they are the contract this task is reviewed against. Two ui tasks are filed in `blocked/` until
this task is archived.

## Why

All measured on 2026-09-30 and 2026-10-01 against main and the configured HAF node.

- **`hafsql.comments.body` never takes an edit.** HafSQL's sync (`updateEditedComment` in its
  `src/app/sync/comments.ts`) passes the incoming op body and the stored body to `patchBody` in
  swapped roles: it parses the stored prose as a patch, that throws, and the `catch` writes the
  stored body back. Title, `json_metadata` and `last_edited` follow the latest op. Measured on
  every edited post sampled (patch edits and full-body edits alike), including PEvO's one edited
  paper: the default detail serves its version 1 (13711 chars) while `?version=2`,
  `condenser_api.get_content` and `bridge.get_post` hold 13523.
- `fetchPaperDetailFromHaf` in `backend/src/routes/papers.ts` reads `c.body` from
  `hafsql.comments` and replaces it with the walker's replay only `if (chain.length > 1)`. Every
  PEvO paper today is a single post. So the paper page never shows an edit, and the edit page
  builds its form and its diff base from the creation body: every edit after the first is a patch
  against text the chain no longer holds, applied fuzzily over the edited body.
- **A failed walk is stable-cached.** `reconstructVersionsFromHaf` returns `[]` on any swallowed
  query error; the fetcher then substitutes a one-entry stub (`block_num: 0`), and
  `hafCache.getOrSet(cacheKey, ..., 30 * 60_000, true)` serves that stub, or a degraded partial
  chain, as a 200 for 30 minutes. (An aborted walk is already safe: the fetcher returns null on
  `signal?.aborted`, and the route answers 503. Pin that with a spec; do not rebuild it.)
- **The `metadata_restored` fallback can be stable-cached in the indexing window.** For 0.15 to
  0.45 s after a new post lands, the op view has it and `hafsql.comments` does not; a detail read
  then takes the fallback and caches an entry with `is_accredited: false`, no accredited authors
  and zero reputation for 30 minutes.
- **One unparseable `@@` body empties a paper's history.** `applyHivePatch` calls
  `patch_fromText` with no catch; the throw lands in `reconstructVersionsFromHaf`'s outer catch,
  which returns `[]` for the whole chain. hivemind treats such a body as a full replacement.
- **Nothing can tell a composer what the chain holds now.** Every detail path is a 30-minute
  stable cache entry, and the composer's own landing sequence reads the paper 1.5 s after the
  broadcast resolves, before HAF has the op in most custody edits (HAF shows a block 1.2 to 2.1 s
  after its slot; the broadcast resolves before the block exists). That read re-caches the
  pre-edit paper for 30 minutes.
- **A repeated op outdates every review.** Every comment op is a version entry, and the
  enrichment route's `const outdated = reviewedVersion < latestVersion;` counts them all. The
  retry design in § 8 makes repeats (an op that leaves the replayed body, title and metadata
  unchanged) a normal outcome.

## Scope

1. **The detail body is the replay.** In `fetchPaperDetailFromHaf`, take `body`, `abstract`,
   `title` and `json_metadata` from the latest replayed version for every paper, not only under
   `chain.length > 1`. `hafsql.comments.body` may stand in only when the replay is empty AND the
   post's `last_edited` is null (a never-edited post). For an edited post whose replay fails or
   comes back empty, the fetcher throws a `HafQueryError` with no pg code: the detail, `/cite` and
   retract routes already answer that with a retriable 503 through `isRetriableHafError`, and it
   skips the `metadata_restored` fallback. The `?version=N` fetcher does not go through
   `fetchPaperDetailFromHaf`; make it throw the same way for an edited post whose replay is empty
   (today it answers 404 "Version not found").
2. **A parse failure is a replacement.** `applyHivePatch` treats a `@@` body that does not parse
   as a patch as a full body, as hivemind does. It never throws.
3. **No stable cache for a fill that is not the paper.** Never store, in the stable tier, a
   detail built from a stub or degraded version list from a failed replay, or from the
   `metadata_restored` fallback. A short volatile entry or no entry are both acceptable; say
   which in the signal block. Keep the existing abort behaviour and pin it.
4. **The head marker.** One function computes `<head author>/<head permlink>/<version count>/
   <block of the newest op>` over the chain as the walk resolved it. It is null only when the
   replay came back empty or failed, or the walk aborted. A walk that ends in a lasting degraded
   state (a cycle, the hop cap, a root without PEvO metadata or Hive authors) still gets a marker
   over what it resolved, or such a paper could never be edited from PEvO again. The detail
   payload carries it as `head_marker`. The composers compare markers for equality only, and the
   draft-binding ui task computes the same string client side from `head_author`, `head_permlink`
   and `versions[]` until this field ships, so keep exactly this format (each part as it appears
   in the payload, joined by `/`).
5. **`GET /api/papers/:author/:permlink/head`.** Uncached. First answer `exists` from the op view
   (any comment op at the requested pair); a pair with no comment op answers 200 with
   `exists: false` and nulls, not 404, because the composers use it as an existence check on a
   permlink they minted. For an existing pair, resolve the canonical root and the chain like the
   detail route, without reading or writing the canonical-root cache, and return `indexed`
   (`hafsql.comments` reflects the newest op of the chain, so a detail fill made now would hold
   it), `canonical_author`, `canonical_permlink`, `head_author`, `head_permlink` and
   `head_marker`. When the fresh state is `indexed`, its marker is non-null, and it differs from
   the cached detail entry's, evict that detail entry and the enrichment entry. Authenticated (the
   composers are signed in). Its rate limit must admit a poll of one request per second for 15
   seconds on top of two checks per submit; key it per account and state the ceiling. HAF failure
   is the usual retriable 503. One function for the marker and the chain walk, shared with the
   detail route; do not grow a second walker.
6. **Repeats.** A version whose replayed body (the walker's per-version body after this op is
   applied), title and `json_metadata` all equal those of the same post's previous version is a
   repeat: add `is_repeat` to each `versions[]` entry and `current_version` (the `version_number`
   of the newest non-repeat entry) to the detail payload. The enrichment route's review
   `outdated`, `inferVotedVersion` and the revote version compare against `current_version`. Do
   not compare raw op bodies (a full-body retry over a landed patch differs as an op and is still
   a repeat), and do not key this on `is_content_revision` (false for metadata-only versions,
   which carry files, the IPFS document and addressed-review ticks, and must keep outdating
   reviews).

## Out of scope

- The listing abstract, profile, search, review and comment readers that also read
  `hafsql.comments.body`. They are a separate task, held until the upstream report is answered.
- The ui side (the composers' use of the endpoint, the marker and `current_version`).
- `/invalidate` semantics. It keeps its shape; nothing here relies on it beyond what it does now.

## Acceptance criteria

1. The default detail for `pevo.science/pevo-original-whitepaper-2016-2026-revision-mnczwwdm`
   (or a fixture with the same history: a creation op and a later patch op) serves the replayed
   latest body, and its `title` and `json_metadata` come from the same op.
2. A never-edited post still serves its `hafsql.comments` body; an edited post whose replay fails
   is a retriable 503 on the detail, `/cite`, retract and `?version=N` paths, and leaves no cache
   entry.
3. A walker-budget abort leaves no cache entry (existing behaviour, now pinned).
4. A stub or degraded version list from a failed replay, and a `metadata_restored` fill, are not
   stored in the stable tier.
5. `applyHivePatch` on `'@@ this is not a patch'` returns that body, and the paper's version list
   survives it.
6. `head_marker` in the detail equals the head endpoint's for the same state, both follow the
   format in Scope 4 exactly, and a cycle or hop-cap walk gets a non-null marker.
7. The head endpoint returns `exists: false` for an unused permlink without touching the
   canonical-root cache, `exists: true` and `indexed: false` for a post in the op view only, and
   evicts a stale detail entry once indexed with a non-null marker.
8. A repeat does not mark a review of the previous version outdated: a full-body op equal to the
   replayed body is a repeat, the same non-empty patch sent twice is not, and a metadata-only
   version (a new file, new addressed-review ticks) still outdates.
9. Each behaviour above is pinned by a spec, and each spec is probed by reverting its own site.
   Mocked HAF is acceptable under the CLAUDE.md carve-out for the indexing-window and failure
   cases; say which specs use it.
10. In the signal block, state the endpoint's final request and response shape and its rate
    limit. The architect writes `api-contracts/papers.md` from it at review (the contract files
    are outside the backend zone).

## Notes

- The HafSQL defect is upstream and is being reported by the user. Do not work around it
  anywhere except through Scope 1. If it is fixed upstream, Scope 1 still stands: the replay is
  the body hivemind serves, whatever HafSQL stores.
- `chain-walkers.ts` and `papers.ts` are large; keep the change at the sites named here.
- Architect at archive, not for the implementer: run `/ce-compound-refresh` on
  `solutions/conventions/hafsql-comments-body-never-follows-an-edit-read-the-replay.md` (its
  status paragraph and reader list are labelled pending) and on
  `solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md`
  (its pre-fill-from-the-head claims hold again once this lands; its line anchors and file
  locations are stale).

---
title: "Operations on a Redis index of opaque full keys must stay in one key-space — set-diffing against bare resource ids misclasses every member, and re-applying the key-builder to an already-full key DELs a double-prefixed no-op"
date: 2026-06-15
category: conventions
module: backend/src/reputation
problem_type: convention
component: background_job
severity: high
applies_when:
  - A Redis Set or index stores OPAQUE FULL keys (the output of a key-builder), not bare resource identifiers
  - A maintenance path set-diffs the index against a live collection to find stale members, then SREM/DEL them
  - The live collection is sourced separately and holds BARE identifiers (usernames, ids) rather than full keys
  - Any member operation re-runs the key-builder on a value already read back from the index
tags:
  - sidecar-index
  - redis
  - key-space
  - opaque-key
  - set-difference
  - double-prefix
  - reputation-batch
---

# Operations on an opaque-full-key Redis index must stay in one key-space

This is the third shape in the sidecar-index family. The companion `sidecar-index-writer-completeness-2026-06-12.md` covers *who must write* the index; this one covers *how every consumer must treat what was written* once the members are opaque full keys.

## Context

The batch reputation job keeps a Redis "members index" Set (`REDIS_KEY_BATCH_MEMBERS`) so reads can enumerate scored users via `SMEMBERS` + `MGET` instead of a blocking `KEYS ${BATCH_KEY_PREFIX}*` scan. The `CYCLE_SWAP` Lua (`lib/redis-scripts.ts`) `SADD`s each post-RENAME **full prod key** into this Set: `batchKey(username)` = `${BATCH_KEY_PREFIX}<username>`. The Set never self-trims, so each cycle a prune (`pruneDeAccreditedMembers` in `reputation-batch.ts`) must remove members no longer in the live accredited set and DEL their stale per-user score keys.

Two collections meet at the prune, and they live in **different key-spaces**:

- The index members are **full keys** (`${BATCH_KEY_PREFIX}<username>`) — the shape the Lua `SADD`s.
- The live accredited set, `getAllAccreditedAccounts()` (`accreditation.ts`), returns **bare usernames**.

Conflating the two produced two coupled silent failures. The prune passed a prior review round and an isolated `invalidateOnRevocation` test — but that test seeded/checked one account and never exercised the diff loop, so the key-space mismatch never surfaced.

## Guidance

When a Redis index stores **opaque full keys** (prefix + resource), treat every member as an opaque handle. Two rules:

**1. One key-space for any set-difference / intersection.** Never compare index members against a bare-resource collection. Bring both sides into a single space first — map the bare side *up* through the key-builder, or strip the index side *down*, but pick one direction. The fix maps up:

```ts
// pruneDeAccreditedMembers — FIXED
const currentMembers = await redis.smembers(membersKey);        // full keys
const liveKeys = new Set([...scoredUsers].map(batchKey));        // bare -> full
const stale = currentMembers.filter((m) => !liveKeys.has(m));   // full vs full
```

The broken form tested `scoredUsers.has(fullKey)` — a bare-username Set membership-tested against a full key — which is **always false**, classing every member stale every cycle.

**2. Never re-apply the key-builder to a value that is already a full key.** Index members are full keys; mutate them directly:

```ts
prunePipe.srem(membersKey, ...stale);          // stale are full keys — correct
for (const m of stale) prunePipe.del(m);       // DEL the full key directly
```

The broken form did `del(batchKey(m))` on an already-full `m`, double-prefixing to `${appTag}:reputation:batch:${appTag}:reputation:batch:<username>` — a key that does not exist, so the DEL was a no-op and stale score keys leaked. (`SREM` was already correct in the broken code because it operated on the un-rebuilt full `stale` keys; only the `DEL` re-applied the builder. The two diverged precisely because one re-prefixed and one did not.)

## Why This Matters

The two defects have **opposite, both-silent** signatures:

- **Cross-key-space diff -> over-deletes / churns.** Every member classed stale -> the prune `SREM`-empties the index immediately after `CYCLE_SWAP` repopulated it. Bulk reads via `getBatchReputationMap` (`SMEMBERS` + `MGET`) then return empty until the next swap re-`SADD`s, so reputation lists silently blank between cycles.
- **Double-prefixed mutation -> under-deletes / leaks.** The DEL targets a nonexistent key, so a de-accredited account's score key survives. `getReputationScore` reads the prod key directly (`batchKey(account)`), so it keeps serving the stale positive score even though the account is sanctioned or below WoT threshold — exactly the collapse-to-zero the prune exists to enforce.

In PEvO every Redis key is `${config.appTag}:`-prefixed (see `reference_redis_app_tag`), so re-prefixing always yields a visibly doubled `${appTag}:...${appTag}:...` path — a useful tell when grepping for the bug, but invisible at runtime because the wrong key simply does not exist and the command no-ops rather than erroring.

## When to Apply

- Diffing or intersecting a Redis Set/index against any other collection (a live allowlist, a "should-exist" set, another index).
- Calling `SREM` / `DEL` / `EXPIRE` / `GET` on members read back from an index.
- Designing or reviewing the **writer** and the **reader/pruner** of any sidecar index together: confirm both agree on whether members are full keys or bare resources, and state the contract at the boundary. The fixed `pruneDeAccreditedMembers` docblock does this ("the index entries and the prod score keys are BOTH full prod paths, while `scoredUsers` holds bare usernames").
- This is the operational companion to writer-completeness: that rule covers *what the writer must `SADD`*; this one covers *how every consumer must treat what was `SADD`ed*.

## Examples

**Seed the test in the index's real key-space, or it passes vacuously.** The regression test seeds the index with **full keys** exactly as the Lua does, and passes the live set as **bare usernames** exactly as `getAllAccreditedAccounts` returns — so it reproduces the real mismatch:

```ts
// Seed as a completed cycle would: FULL-batchKey entries in the index.
await redis.set(batchKey(live),  JSON.stringify({ score: 10, breakdown: { /* ... */ } }));
await redis.set(batchKey(stale), JSON.stringify({ score: 99, breakdown: { /* ... */ } }));
await redis.sadd(membersKey, batchKey(live), batchKey(stale));   // FULL keys

// Live accredited set holds BARE usernames; only `live` remains.
await batchSeams.pruneDeAccreditedMembers(redis, membersKey, new Set([live]), 1);

expect(members).toContain(batchKey(live));            // accredited survives
expect(members).not.toContain(batchKey(stale));       // de-accredited pruned
expect(await redis.exists(batchKey(live))).toBe(1);   // score key survives
expect(await redis.exists(batchKey(stale))).toBe(0);  // stale score key removed
```

This fails against the pre-fix code on **both** defects: the bare-vs-full diff would also strip `live` (over-delete), and the double-prefixed DEL would leave `batchKey(stale)` present (under-delete). Had the test seeded **bare** usernames into the index, it would have matched the broken comparison and passed vacuously — the failure mode the seed-shape discipline guards against.

**Testability seam.** The prune was extracted into `pruneDeAccreditedMembers(redis, membersKey, scoredUsers, cycle)` exposed via `__test_seams`, with `membersKey` as a parameter so the blanket "remove everything not in `scoredUsers`" prune can target a test-unique key and not race sibling files' writes to the shared production index.

## Related

- `sidecar-index-writer-completeness-2026-06-12.md` — companion convention on the SAME members index: that one covers writer/deleter completeness (who must `SADD`/`SREM`), this one covers key-space consistency of the operations on it. Check both when touching a sidecar index.
- `json-metadata-raw-map-use-safepevometa-2026-06-06.md` — the same silent-no-op-on-wrong-key-space failure shape on a different surface (reading `json_metadata.pevo` instead of `meta[config.appTag]` returns structurally-valid output that silently drops data).
- `strict-superset-wrapper-inherits-escape-hatches-2026-05-12.md` — the inverse appTag-namespace failure (an ioredis `keyPrefix` REPLACING the parent prefix rather than double-applying it).

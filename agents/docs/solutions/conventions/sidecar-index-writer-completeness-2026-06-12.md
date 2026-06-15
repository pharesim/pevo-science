---
title: "A sidecar index maintained by some-but-not-all writers, or maintained conditionally, drifts — every writer indexes unconditionally, or the read path must heal partial divergence"
date: 2026-06-12
category: conventions
module: backend/src/reputation
problem_type: convention
component: background_job
severity: medium
applies_when:
  - A derived membership structure (Redis Set, lookup table, materialized list) indexes primary records so reads can enumerate without scanning
  - More than one code path creates or deletes the indexed resource (batch swap, seed/bonus writers, backfills, revocation/delete paths)
  - The read path trusts the index for enumeration and has no per-entry reconciliation
tags:
  - sidecar-index
  - members-set
  - redis
  - writer-completeness
  - conditional-write
  - self-heal
  - drift
related_components:
  - database
  - testing_framework
---

# Sidecar index writer-completeness: index unconditionally from every writer, or heal partial divergence on read

When a read path enumerates via a sidecar index (here: the reputation `batch_members` Redis Set that `getBatchReputationMap` reads via SMEMBERS + MGET instead of a blocking KEYS scan), the index is only as complete as its LEAST diligent writer. Two distinct failure shapes produced the same user-visible bug (a freshly accredited user invisible to the reputation map until the next cycle swap), one round apart:

1. **Missing writer.** The index was initially maintained only inside the cycle-swap Lua script. The seed writers (`seedAccreditationBonus`, `backfillAccreditationSeeds`) created prod keys without touching the index, so seed-only users were unindexed in steady state.
2. **Conditional write.** The first fix added the seed-path index write but gated it on the data write's outcome: SADD only when the NX SET returned `'OK'`, reasoning "an NX no-op means the key already exists, so it is already a member." The second clause is false after a crash between an earlier SET and its separate SADD: the key exists but is unindexed, the retry's NX no-ops, the gate skips the SADD on a false already-a-member assumption, and the orphan persists. The read path's self-heal could not save it because the SCAN backfill fires only on a WHOLLY-empty index — a single orphan in a populated index is never reconciled until the next cycle swap or a restart backfill.

## Guidance

- **Enumerate every writer of the indexed resource** (creators AND deleters) and make each one maintain the index. A deleter that skips the index removal accumulates stale members; a creator that skips the addition produces invisible records.
- **Make the index write unconditional**, even when the data write is conditional. Conditionality that is correct for the data write (SET NX: "don't clobber a real value") is almost never correct for the sidecar write: the index write's job is "this key must be a member after this call returns," which holds on BOTH branches of the data write. Idempotent index ops (SADD, INSERT ... ON CONFLICT DO NOTHING) make the unconditional form cost one cheap round-trip.

  ```ts
  // WRONG: gates the index write on the data write's outcome
  const setResult = await redis.set(key, value, 'NX');
  if (setResult === 'OK') await redis.sadd(membersKey, key);

  // RIGHT: data write conditional, index write unconditional
  await redis.set(key, value, 'NX');
  await redis.sadd(membersKey, key); // idempotent; closes the crash-retry orphan window
  ```

- **If any writer cannot be made complete, the read path must both tolerate AND eventually heal divergence** — and "heal" must cover PARTIAL divergence. A backfill that triggers only on an empty index tolerates the bootstrap case but never reconciles a single orphan in a populated index. Tolerating stale members is the easy half (null-skip on fetch); healing missing members is the half that needs an explicit mechanism (periodic full rebuild, e.g. a cycle swap that re-SADDs every key it writes, bounded the staleness here to one cycle).
- **Pin the write paths, not just the read paths.** The test that ended this class asserts membership at the writer level, including the mutation-kill case for the conditional form: pre-create the prod key WITHOUT the index entry, run the writer (its NX no-ops), assert the key IS a member afterward. The gated implementation fails that test red; read-path tests (backfill, null-skip) all stayed green across both buggy rounds.

## Why This Matters

Index drift is invisible until a read needs the missing member, and the symptom (one user absent from an aggregate) looks like data lag, not a code bug. Both failure shapes here passed typecheck, lint, and every read-path test. The conditional-write shape is the dangerous one because it survives review: the gate reads as a sensible optimization, and refuting it requires reasoning about a crash window between two non-atomic writes plus the retry path's assumptions.

## When to Apply

Any time a reviewer or implementer sees a derived membership structure: ask (1) who else writes the indexed resource, (2) is every index write unconditional or gated only on a predicate that is invariantly true for indexing purposes, (3) does the read path heal partial divergence or only the empty-bootstrap case, (4) is there a writer-level membership pin with the orphan-window mutation-kill shape.

## Related

- `object-shape-fix-every-reset-site-2026-04-21.md` — the enumerate-every-write-path meta-pattern (Alpine state context).
- `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — exhaustive call-site audits when a primitive gains a wrapper.
- `synchronous-flag-before-await-idempotency-guard-2026-05-16.md` — the conditional-guard-reopens-window analog in async UI code.
- `sidecar-index-member-ops-single-key-space-2026-06-15.md` — companion on the SAME members index: this one covers writer/deleter completeness (who must maintain the index), that one covers key-space consistency of the operations on it (how consumers must treat the opaque full keys).

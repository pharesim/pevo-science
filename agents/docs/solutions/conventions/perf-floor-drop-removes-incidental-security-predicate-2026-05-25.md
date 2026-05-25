---
title: "A performance floor-drop can remove an incidental security predicate; re-audit for an authorship gate"
date: 2026-05-25
category: conventions
module: backend/src (hafsql.ts, routes/papers.ts)
problem_type: convention
component: database
severity: high
applies_when:
  - "Dropping a `block_num >= genesis` (or similar lower-bound) floor from a HAF `custom_json` query to avoid the BitmapAnd planner trap"
  - "Optimizing a `cj.custom_id = $appTag` query by removing a conjunct that looked like a pure planner hint or correctness floor"
  - "Any read site over chain-sourced rows where a predicate is removed for performance and the remaining predicates are all metadata-shape checks, not authorship checks"
related_components:
  - authentication
  - development_workflow
tags:
  - haf
  - bitmapand
  - block-num-floor
  - required-posting-auths
  - forgery-gate
  - perf-security-coupling
  - custom-json
  - query-planner
---

# A performance floor-drop can remove an incidental security predicate; re-audit for an authorship gate

## Context

PEvO read sites query Hive `custom_json` operations from HAF filtered by `cj.custom_id = $appTag`. Several of these queries also carried a `cj.block_num >= $genesis` floor. That floor was added to exclude pre-namespace operations from generic indexes, but it is a documented BitmapAnd performance trap: on the HAF node, combining the ~15-row `custom_id` namespace with the lower-bound `block_num` filter makes the planner intersect the `custom_id` index with the multi-tens-of-millions-row `block_num` index via BitmapAnd, forcing a parallel scan that runs in seconds. The established fix (first applied to `activeAccreditationsCteBody` in commit `285e7c14`) is to drop the floor: `custom_id = $appTag` alone is selective enough.

The non-obvious trap: that floor was doing **double duty**. Besides its (failed) performance role, it was incidentally narrowing the *trusted* row set, excluding pre-namespace / replayed / cross-app operation rows from consideration. Drop it purely as a planner fix, and you silently widen the admitted set at a read site whose remaining predicates only check metadata *shape* (`json ->> 'action' = 'retract_paper'`), never *authorship*. The result was a forgery surface.

## Guidance

**When you drop a floor predicate from a HAF `custom_json` read query for performance reasons, treat it as a security change, not just a planner change. Before considering the optimization done, re-audit every read site over that op type for a chain-enforced authorship gate, and add one if it is missing.**

For admin-issued ops the gate is the JSONB containment predicate against the legitimate issuer:

```sql
AND cj.required_posting_auths ? $admin   -- $admin = config.hiveAdminAccount
```

Use the singular `?` operator (does the array contain this string?) when the legitimate broadcaster set is exactly one account. `config.hiveAdminAccount` is singular by design (auto memory [claude]: `project_admin_is_singular`), so `?` is correct rather than `?|` with a one-element array. The accreditation CTE uses `?|` against `config.accreditationAuthorities` precisely because that broadcaster set is plural; the operator choice follows the cardinality of the legitimate-issuer set.

This gate is sound because Hive consensus only admits a `custom_json` into a block if **every** account named in `required_posting_auths` signed it with its posting key. An attacker cannot list `config.hiveAdminAccount` in `required_posting_auths` without holding admin's posting key, so HAF never ingests a forged admin-authored row. The predicate therefore proves authorship, not merely name-in-array.

Apply the gate at **every** read site for the op type, not just the one on the hot path. In the triggering cluster the retraction op had four read surfaces (`retractedPapersCteBody` in `hafsql.ts`, consumed by both the papers list and `search.ts`; `loadRetractedPapers`; and `isRetracted` in `papers.ts`). A gate present on the CTE but missing on an inline `pool.query` sibling re-opens the same hole through a different door.

## Why This Matters

Without the authorship gate, after the floor-drop any account can broadcast `{custom_id: <appTag>, action: 'retract_paper', author: <victim>, permlink: <victim-paper>}` with its own posting key and suppress the victim's paper from listings, search, and the paper-detail retraction overlay (and surface a bogus 422 on a legitimate retract). The producer-side convention — only the retract handler broadcasts, signed with `config.pevoAdminPostingKey` — is not a chain-enforced read-side gate; the read query trusted any row whose `custom_id` matched.

The danger is that the floor-drop looks purely like a performance change in review. The diff removes a `block_num >= $genesis` conjunct and a `getCachedGenesisBlock()` argument; nothing in it mentions authorization. The security regression is invisible from the SQL-shape lens alone — it only appears when you ask "what was that predicate *also* excluding, and is anything else excluding forged rows now?"

Note the gate is not a re-introduction of a `block_num` floor (which would bring back the BitmapAnd trap). The `?` containment operator is not a B-tree range predicate, so it does not trigger BitmapAnd; it runs as a residual filter over the `custom_id`-narrowed set. At small namespace size this is negligible. If retraction volume ever grows, the residual-filter cost is linear and depends on whether the HAF node has a GIN index on `required_posting_auths` — and HAF indexes are fixed external infrastructure that PEvO cannot add (auto memory [claude]: HAF indexes cannot be modified), so the lever there is to confirm the index with the operator or document the threshold, not to add one.

## When to Apply

- Any time you drop a lower-bound or app-scoping conjunct from a `custom_json` read query for BitmapAnd / planner reasons.
- When optimizing a query whose surviving predicates check only the op's metadata shape, never the signer.
- When a code review frames a change as "perf only" but it removes a predicate over chain-sourced, attacker-broadcastable rows.

## Examples

Floor-drop (commit `966fa7c8`) — looks perf-only, silently widens the trusted set:

```sql
-- before
WHERE cj.custom_id = $1
  AND cj.json::jsonb ->> 'action' = 'retract_paper'
  AND cj.block_num >= $2          -- dropped: BitmapAnd trap
-- after the floor-drop, ANY broadcaster's retract row is admitted
WHERE cj.custom_id = $1
  AND cj.json::jsonb ->> 'action' = 'retract_paper'
```

Authorship gate that had to follow (commit `d76f97e8`) — restores read-side trust without re-introducing the floor:

```sql
WHERE cj.custom_id = $1
  AND cj.json::jsonb ->> 'action' = 'retract_paper'
  AND cj.required_posting_auths ? $2   -- $2 = config.hiveAdminAccount
```

The lesson is the **pairing**: the second commit is not optional cleanup, it is the security half of the first commit's optimization. Land them together (or gate behind the same deploy) so no window exists where the floor is gone and the authorship gate is absent.

## Related

- `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` — the BitmapAnd sweep that produced this floor-drop; covers finding every SQL site carrying the trap. Composes with this doc: find all sites (that doc), then audit each for the authorship gate (this doc).
- `agents/docs/solutions/conventions/sql-semantic-shift-cross-surface-audit-2026-05-12.md` — the general "audit what else a dropped predicate was doing" discipline; this is its sharpest security-critical instance (a perf-motivated floor-drop, not a gate-replace).
- `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` — Rule 5 (signer-subject binding) is the correct form of the gate; `required_posting_auths ? $admin` is the admin-issued-op application of it.
- `agents/docs/solutions/conventions/auth-gate-revives-pre-existing-read-side-oracle-2026-05-17.md` — route-layer meta-analog: a structural change reveals a latent read-side trust gap. This doc is the SQL-layer sibling (content forgery rather than an enumeration oracle).
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — the foundational principle that authorization gates must terminate in an identity predicate (who, not what); the authorship gate is an application at the `custom_json` signer layer.

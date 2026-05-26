# BACKEND-IPFS-IMAGE-SRF-GUARD — CASE-WHEN guard for jsonb_array_elements_text on json_metadata->'image'

**Owner:** Backend Agent
**Created:** 2026-05-21 (architect, surfaced by `/ce-code-review` of commit `1b2f9b8f` self-review-exclusion round-4)
**Priority:** P2 (reliability — per-request blast radius, not cycle-cascade)

## Why now

The BACKEND-SELF-REVIEW-EXCLUSION round-4 commit closed cascade-fail vulnerabilities at two SRF-argument sites (`reputation.ts citing_papers` CTE + `hafsql.ts authorsWithSupersessionSelect`). During that round's `/ce-code-review`, the security and adversarial reviewers flagged two PRE-EXISTING sibling sites with the same vulnerability shape on the bare Hive `image` field:

- `backend/src/routes/ipfs.ts:344` (`cidIsKnown` gate for `GET /ipfs/:cid`)
- `backend/src/ipfs-cleanup.ts:38` (CID-in-use check in the cleanup job)

Both invoke `jsonb_array_elements_text(c.json_metadata->'image')` without a `jsonb_typeof = 'array'` guard. Hive convention is that `json_metadata.image` is an array of URL strings, but the field is broadcaster-controlled in the bare Hive namespace and Hive posts widely broadcast `image` as a single string, null, integer, or missing entirely. When a Hive post with non-array `image` enters the SRF's input set, Postgres raises `cannot extract elements from a scalar`.

Per-request blast radius (not cycle-cascade like the reputation-batch sites this commit just fixed):

- `routes/ipfs.ts:344` — the IPFS gateway's CID-in-use check. Failure here causes the `/ipfs/:cid` endpoint to error out for every CID lookup as long as at least one post in the relevant scan window has malformed `image`.
- `ipfs-cleanup.ts:38` — the cleanup job's "is this CID still referenced" check. Failure causes the cleanup job to crash on each run, potentially leaving orphaned IPFS pins.

These were OUT-OF-SCOPE for the self-review-exclusion task (which covered PEvO-namespaced metadata: `pevo.authors`, `pevo.citations`). The same fix pattern applies; the same risk class is present; one Hive post on chain triggers either failure mode.

## Goal

Apply the canonical `CASE WHEN jsonb_typeof(...) = 'array' THEN ... ELSE '[]'::jsonb END` guard at the SRF argument position at both sites. Per `agents/docs/solutions/conventions/pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md`.

## Acceptance criteria

### 1. Fix at both SRF call sites

**`backend/src/routes/ipfs.ts:344`** (`cidIsKnown`):

```sql
-- Before:
EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(c.json_metadata->'image') AS img
  WHERE img ILIKE '%' || $1 || '%'
)

-- After:
EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(c.json_metadata->'image') = 'array'
         THEN c.json_metadata->'image'
         ELSE '[]'::jsonb
    END
  ) AS img
  WHERE img ILIKE '%' || $1 || '%'
)
```

**`backend/src/ipfs-cleanup.ts:38`** — same pattern, applied to whatever variant of the same SRF call exists there (read the file at HEAD to confirm exact form).

### 2. Behavioral tests

Mirror the citing_papers cascade-fail-defense test pattern landed in `backend/tests/hafsql.test.ts` (round-4 of self-review-exclusion). Synthetic VALUES + real Postgres, exercise non-array shapes (string, integer, null, object, missing) + well-formed control. Assert each call site does NOT raise on malformed input.

Real-corpus seeding of malformed-image Hive posts is impractical (the test corpus is Mahdi's HAF; we don't control its content). Carve-out clause-(c) applies — document in the test file header.

### 3. Comment block at each fix site

Brief comment per `pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md` explaining the LATERAL-evaluates-before-WHERE trap and citing the convention doc.

## Out of scope

- Other `jsonb_array_elements_text` sites in `backend/src/` that operate on non-broadcaster-controlled fields. The audit table at `agents/docs/solutions/conventions/pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md` should be re-synced as part of this task's archive, but the IPFS sites are the only currently-unguarded ones flagged by reviewers.
- Migrating `jsonb_array_elements_text` to `jsonb_array_elements` + `->>` extraction. The text-variant is the right API for this use case; only the guard is missing.
- IPFS cleanup-job semantics or the gateway's caching layer. Single-knob fix.

## Coordination

- The architect-zone refresh of `pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md` (stale anti-pattern examples + line-number anchors) is a separate concern handled via `/ce-compound-refresh`. When this task archives, the architect should ensure the convention doc's audit table reflects these two sites as guarded.

## Source

- `/ce-code-review` security sec-1 (conf 75) + adversarial ADV-PREEXISTING-IPFS-SRF-UNGUARDED (conf 75) on commit `1b2f9b8f`. Filed as separate task per the architect's round-5 hold disposition for the self-review-exclusion task — out-of-scope for that task (which covered PEvO-namespaced metadata).

## Cross-references

- `agents/docs/solutions/conventions/pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md` (the canonical convention).
- `agents/docs/solutions/conventions/pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md` (companion).
- `backend/src/routes/ipfs.ts` (`cidIsKnown` / `/ipfs/:cid` gateway).
- `backend/src/ipfs-cleanup.ts` (cleanup job).
- `backend/tests/hafsql.test.ts citing_papers CROSS JOIN LATERAL cascade-fail defense` — reference pattern for the behavioral test shape.

## Architect re-review (2026-05-26) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on commit `3d60e9ad` (8-persona fan-out). The fix is correct and complete: the adversarial pass empirically could not break the guard against real Postgres (every non-array shape is absorbed), performance confirms the CASE-WHEN is plan-neutral, and the two `image` SRF sites are the only ones — verified that every other `jsonb_array_elements` site in `backend/src` is already guarded. The hold is for test-durability and label fixes only:

- **Add a source-level guard-presence canary.** The behavioral test runs a hand-copied SQL shape (`guardedSrfShape`), not the live `cidIsKnown` / `cidReferencedInHaf`, so a revert of the CASE-WHEN at either production site would leave the suite green. Add a canary that reads `backend/src/routes/ipfs.ts` and `backend/src/ipfs-cleanup.ts` and asserts the `CASE WHEN jsonb_typeof(...) = 'array'` guard is present at the `jsonb_array_elements_text` call site in each, on the model of the existing `notification-queries-lateral-guard-canary` test.
- **Fix the skip-message label.** The four `ctx.skip(...)` calls say "no app pool available", but the gated handle is `getPool()` (the HAF pool), not `getAppPool()` (the app pool). Change to "no HAF pool available".
- **Fix the carve-out clause label.** The header labels its real-path-impracticality justification as "Carve-out clause-(c)", but that content is the clause-(a) requirement (which real path is impractical and why). Relabel to clause-(a); the clause-(c) real-path-companion statement can remain as its own line.

On archive of this task, the architect will re-sync `agents/docs/solutions/conventions/pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md` to list `cidIsKnown` and `cidReferencedInHaf` among the guarded sites, per this task's Coordination note.

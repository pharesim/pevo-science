---
title: Test teardown wildcard DELETE over a shared synthetic-ID band collides with concurrent sibling files under parallel workers
date: 2026-06-14
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Vitest config sets `maxWorkers > 1` (PEvO: `maxWorkers: 2`), so two test files run concurrently"
  - "A test block seeds rows into a shared table (`accounts`, `papers`, etc.) using a synthetic-ID namespace that sibling test files ALSO write into (e.g. the `0000-0003-<ts-last4>-NNNN` ORCID band)"
  - "The per-block uniqueness token is truncated (`Date.now() % 10000`, `.slice(-4)`, a fixed small integer) rather than a full timestamp or UUID"
  - "The `afterAll` / `beforeEach` cleanup deletes by a WILDCARD predicate (`LIKE 'prefix-%'`) over that shared band rather than by exact ID"
related_components:
  - authentication
  - database
tags:
  - vitest
  - test-isolation
  - teardown
  - parallel-workers
  - fixture-cleanup
  - flake
  - cross-file-contamination
---

# Test teardown wildcard DELETE over a shared synthetic-ID band collides with concurrent sibling files under parallel workers

## Context

PEvO's backend test suite runs with `maxWorkers: 2` (`backend/vitest.config.ts`), so two test files always execute concurrently. Several route test files seed the `accounts` table with synthetic ORCID IDs drawn from a shared namespace prefix: `0000-0003-<last4-of-timestamp>-NNNN`, where the last-4 comes from `Date.now() % 10000` (a value in `[0000, 9999]`). Files in this family include `auth.test.ts`, `settings-email-fresh-auth.test.ts`, `settings-email-delete-fresh-auth.test.ts`, `settings-set-password.test.ts`, `settings-set-password-fresh-auth.test.ts`, and `middleware/verifyHiveSignature-reissuedat-orcid-roundtrip.test.ts` (enumerate with `grep -rn "0000-0003-" backend/tests/`).

A new `describe` block in `auth.test.ts` cleaned up in `afterAll` with `DELETE FROM accounts WHERE orcid LIKE '0000-0003-${suffix}-%' OR email LIKE '${EMAIL_PREFIX}%'`. Because the orcid arm is a WILDCARD over the shared band and the uniqueness token is only 4 digits, when a concurrently-scheduled sibling file happens to compute the same `Date.now() % 10000`, this teardown deletes the sibling's seeded rows mid-test. Collision probability is roughly 1/10000 per concurrently-scheduled pair: rare in a single run, cumulative across CI history and local iteration.

This is a DISTINCT flake mechanism from PEvO's known load-induced suite failures (429/503/504 from the external HAF SQL node under parallel load; see `project_fullsuite_test_flakiness` operator note). Load failures surface as HTTP-error assertions or timeouts; this surfaces as a missing-row / unexpected-404 failure inside a test whose own code is correct. The damage arrives from another file's teardown, not from network conditions. Do not dismiss it as load noise.

## Guidance

A test block's cleanup MUST delete by exact ID (or by a per-file-unique token wide enough to be collision-proof), NEVER by a wildcard over a namespace that sibling test files also write into.

Two safe shapes:

Exact-ID list (preferred when the seed set is small and statically enumerable):

```ts
// SAFE: enumerate every id this describe block seeds; exact-match cannot
// touch a foreign row even if the truncated suffix collides with a sibling.
afterAll(async () => {
  const pool = getAppPool()!;
  await pool.query(
    `DELETE FROM accounts WHERE orcid = ANY($1) OR email LIKE $2`,
    [
      [`0000-0003-${suffix}-0001`, `0000-0003-${suffix}-0002`, `0000-0003-${suffix}-0003`],
      `${EMAIL_PREFIX}%`,
    ],
  );
});
```

Full-timestamp / UUID prefix (preferred when the seed set is dynamic or large):

```ts
const RUN = Date.now();              // full millisecond timestamp, never truncate
const EMAIL_PREFIX = `null_pw_${RUN}_`;
afterAll(async () => {
  await pool.query(`DELETE FROM accounts WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
});
// A full Date.now() prefix can only collide if two workers start within the
// same millisecond AND draw the same prefix — astronomically unlikely at maxWorkers=2.
```

The unsafe shape that triggered this convention:

```ts
// UNSAFE: wildcard over a shared band with a 4-digit uniqueness token.
const suffix = (Date.now() % 10000).toString().padStart(4, '0');
afterAll(async () => {
  await pool.query(
    `DELETE FROM accounts WHERE orcid LIKE $1 OR email LIKE $2`,
    [`0000-0003-${suffix}-%`, `${EMAIL_PREFIX}%`],
  );
});
```

Note the instructive asymmetry in the unsafe example: the email arm (`null_pw_${RUN}_`) embeds the FULL `Date.now()` and is collision-proof, while the orcid arm truncates to 4 digits AND uses a wildcard. Both arms can coexist in one teardown; only the truncated-wildcard arm is dangerous.

## Why This Matters

A wildcard teardown that reaches into a sibling file's seeded rows causes failures in the SIBLING's tests, not in the teardown's own file. The failing test's internal logic is correct; the row it expected simply no longer exists. That makes the root cause very hard to locate: the failing test looks fine, the teardown that caused the damage lives in a different file, and the failure is intermittent (scheduler timing plus suffix collision). Under `maxWorkers: 2` with a 4-digit suffix, the collision is frequent enough to surface across CI history yet rare enough to seem non-reproducible in isolation, so it is easily misattributed to the suite's pre-existing load noise and left unfixed.

## When to Apply

Apply this review heuristic to any test cleanup (`afterAll`, `afterEach`, `beforeEach`) that:

- Deletes from a table other test files also write to (`accounts`, `papers`, `reviews`, etc.), AND
- Derives its uniqueness token from `Date.now() % N`, `.slice(-N)`, or a fixed small integer (not a full timestamp / UUID), AND
- Runs under `maxWorkers > 1` (check `backend/vitest.config.ts`).

Two diagnostic questions for any teardown predicate:

1. Could this predicate match a row another file created? Grep the shared prefix across `backend/tests/` to enumerate co-owners; if more than one file generates matching IDs, a wildcard predicate is unsafe.
2. Is the uniqueness token wide enough? Full `Date.now()` (millisecond precision) is effectively collision-proof across two workers; the last-4 digits are ~1/10000 per scheduled-file overlap and therefore unsafe under concurrency.

If the answers are "yes" / "no", switch to exact-ID `= ANY([...])` enumeration or a full-timestamp/UUID prefix.

## Examples

Detect co-owners before writing or reviewing a teardown predicate:

```bash
grep -rn "0000-0003-" backend/tests/   # if multiple files appear, you share the namespace
grep -n  "maxWorkers" backend/vitest.config.ts   # confirm > 1
```

For each co-owner, check whether its suffix is truncated (`% 10000`, `.slice(-4)`) or a full timestamp; any block whose suffix is truncated must use exact-ID teardown rather than a wildcard.

## Related

- `conventions/vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md` — closest sibling; both prescribe scoped `DELETE ... = ANY([exact list])` over a table-wide / wildcard wipe. Orthogonal trigger: that doc fires on `retry > 0` + a fire-and-forget side effect within ONE file; this one fires on `maxWorkers > 1` + a wildcard over a band that OTHER files share.
- `conventions/vitest-fake-timers-module-private-state-isolation-2026-04-29.md` — same vitest test-isolation family; the in-process module-state variant (contamination via shared module instance) rather than the cross-file DB-row variant here.
- `conventions/account-state-fixture-must-satisfy-all-dimensions-2026-06-09.md` — the `accounts.orcid` UNIQUE index (migration `007_accounts_orcid_unique.sql`) and per-run-unique synthetic ORCIDs are the production constraint that makes shared-band collisions a real data error, not merely a logical test slip.
- Originating instance: the `password: null` describe block in `backend/tests/routes/auth.test.ts`, whose `afterAll` wildcard DELETE was rescoped to `orcid = ANY([exact ids])`.

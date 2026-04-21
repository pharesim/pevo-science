---
title: Override collapsed role-account config in tests for role-gated routes
date: 2026-04-21
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing tests for a backend route whose authorization compares `username` to multiple `config.hive*Account` role values (admin, bridge, anon, onboard)
  - The dev `.env` leaves one or more role accounts unset and `backend/src/config.ts` falls back to another role's value
  - The route has a signing branch gated on a server-side key (e.g. `pevoAdminPostingKey`) that dev `.env` may leave empty
  - Using `vi.mock('../../src/config.js')` to stub config in a Vitest suite
tags:
  - testing
  - authorization
  - vitest
  - config-mock
  - role-gating
  - backend-routes
  - mutation-testing
related_components:
  - authentication
---

# Override collapsed role-account config in tests for role-gated routes

## Context

PEvO's backend uses several distinct role accounts (`config.hiveAdminAccount`, `config.hiveBridgeAccount`, `config.hiveAnonAccount`, `config.hiveOnboardAccount`) to gate privileged operations. In production these are separate Hive accounts with separate posting keys. In the dev `.env`, several of these fields are left unset and fall back to the admin account via `||` defaults in `backend/src/config.ts` — see line 17 (`const hiveBridgeAccount = process.env.HIVE_BRIDGE_ACCOUNT || hiveAdminAccount;`) and the analogous fallbacks at lines 21-29 for other role accounts and posting keys.

This collapse is a convenience for local development but a trap for tests. If a route test `vi.mock`s `../../src/config.js` and inherits these collapsed defaults, then `caller === config.hiveAdminAccount` and `caller === config.hiveBridgeAccount` evaluate to the same boolean for an admin caller. Role-conflation mutations in the authorization code — for example turning `isAdmin` into `paperAuthor === config.hiveBridgeAccount` — then pass every assertion because the two gates are indistinguishable in the test environment. Tests are green; exploit ships.

SEC-003-BE in `backend/src/routes/claims.ts` was exactly this class of bug. The approve handler gated a server-signed bridge broadcast on `paperAuthor === config.hiveBridgeAccount` (a paper property, not a caller check), and the revoke handler folded the same comparison into the OR-gate as `isBridgeAdmin`. Any authenticated user could inflate reputation or strip authorship. The 10 new tests written with real `verifyHiveSignature` passed, but would not have caught a regression reintroducing the same conflation, because the test config mock only overrode `pevoBridgePostingKey` and left `hiveBridgeAccount` collapsed to the admin account.

## Guidance

When writing a backend route test whose handler references more than one role account on `config`, extend the `vi.mock('../../src/config.js')` factory to set **distinct** values for every role account and every posting key the handler touches. Do this even if — especially if — the dev `.env` collapses them. The test's config mock must reflect production topology, not local-dev shortcuts.

**Before (masks role-conflation mutations):**

```ts
vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
  return {
    ...actual,
    config: { ...actual.config, pevoBridgePostingKey: TEST_BRIDGE_KEY },
  };
});
```

**After (catches role-conflation mutations):**

```ts
vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      hiveBridgeAccount: 'pevotest.bridge',
      pevoBridgePostingKey: TEST_BRIDGE_KEY,
      pevoAdminPostingKey: TEST_ADMIN_KEY,
    },
  };
});
```

Use recognizable, role-specific fixture values (`pevotest.bridge`, `pevotest.anon`, `pevotest.onboard`) and separate test keys per role so that a test failure message immediately points at which role the code exercised.

Do not widen `hiveAdminAccount` into an array or multi-admin construct to simulate separation. `config.hiveAdminAccount` is singular by product design (auto memory: `project_admin_is_singular.md`). The correct separation axis is bridge/anon/onboard, which is already multi-account by design.

## Why This Matters

Role-conflation bugs in authorization code are high-severity by default. SEC-003-BE was a P0: any authenticated user could inflate their own reputation via server-signed bridge broadcasts, or strip another user's authorship. The entire gate collapsed to "is this a paper the bridge account owns," with no check on the caller. That class of mistake is easy to reintroduce, because it looks like a reasonable check at a glance, and it will pass any test suite whose config mock treats admin and bridge as the same string.

Dev `.env` defaults exist to make local setup painless. They are not the production topology. When tests silently inherit those defaults, they provide false safety: every assertion about "only admin can do X" is also silently an assertion about "only the bridge account can do X," and any swap between the two is invisible. In production, where the accounts are distinct, the swap is an exploit. A test suite that cannot distinguish admin from bridge cannot defend the authorization boundary between them.

The cost of the fix is two extra lines in one mock factory. The cost of not doing it is shipping an authorization bypass that every test you wrote claimed was impossible.

## When to Apply

Apply this guidance whenever a backend route test is added or modified and the handler under test references two or more of:

- `config.hiveAdminAccount`
- `config.hiveBridgeAccount`
- `config.hiveAnonAccount`
- `config.hiveOnboardAccount`

It also applies to the corresponding posting keys when the handler uses them to sign server-side broadcasts:

- `config.pevoAdminPostingKey`
- `config.pevoBridgePostingKey`
- `config.pevoAnonPostingKey`

Concrete checklist before committing a new route test:

1. Grep the handler for `config.hive*Account` and `config.pevo*PostingKey` references.
2. For every field referenced, confirm it is overridden in the test's `vi.mock('../../src/config.js')` factory with a value distinct from every other role field in the same mock.
3. If the handler signs with a server-side key, confirm the corresponding key field is also mocked with a role-distinct fixture key, so the broadcast branch is actually reachable under the test's caller identity.
4. Spot-check `backend/src/config.ts` lines 17 and 21-29 for `||` fallbacks affecting the fields you touch. Any field with a fallback to `hiveAdminAccount` or an admin key is a conflation risk and must be explicitly set in the mock.

Skip this only if the handler references exactly one role account and no server-side signing key — no role boundary means nothing to defend.

## Examples

- **Canonical example:** `backend/tests/routes/claims.test.ts` after the SEC-003-BE B5 fix. The config mock sets `hiveBridgeAccount: 'pevotest.bridge'`, `pevoBridgePostingKey: TEST_BRIDGE_KEY`, and `pevoAdminPostingKey: TEST_ADMIN_KEY` distinctly, so the approve handler's admin-broadcast branch and the revoke handler's `paperAuthor === hiveBridgeAccount && isAdmin` gate exercise distinct identities. A mutation swapping `isAdmin` for `paperAuthor === config.hiveBridgeAccount` is now caught because an admin caller is not equal to the bridge account under the test config.

- **Code under test:** `backend/src/routes/claims.ts` approve and revoke handlers. Authorization gates on combinations of `caller === config.hiveAdminAccount`, `caller === claimer`, `caller === postAuthor`, and `paperAuthor === config.hiveBridgeAccount`.

- **Fallback logic to be aware of:** `backend/src/config.ts:17` (`hiveBridgeAccount` falls back to `hiveAdminAccount`) and `backend/src/config.ts:21-29` (analogous fallbacks for other role accounts and posting keys). Any test that relies on these fields without overriding them is implicitly testing the collapsed-role topology, not production.

## Related

- SEC-003-BE (Review, 2026-04-21) — the P0 bug whose review surfaced this gap as finding B5.
- Auto memory: `project_admin_is_singular.md` — why the admin role is singular; do not generalize this convention into "make admin an array".
- `backend/src/config.ts` — the fallback source.

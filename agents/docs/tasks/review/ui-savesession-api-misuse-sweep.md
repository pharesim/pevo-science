# FE-SAVESESSION-API-MISUSE-SWEEP — Sweep remaining `_saveSession(6 args)` call sites

**Owner:** UI Agent
**Priority:** P2
**Created:** 2026-04-21
**Surfaced by:** FE-ORCID-CALLBACK-FIXES archive review (2026-04-21d).

## Context

FE-ORCID-CALLBACK-FIXES (commit `0951fef`) fixed the 6-arg `_saveSession(...)` misuse at `orcid-callback.js:148` and `login.js:152`. The same pattern still exists at three other call sites:

- `signup-verify.js:412`
- `signup-verify.js:457`
- `settings.js:636` — additionally passes `null` as old `expires_at` arg

## Goal

Convert all three call sites to the no-arg `_saveSession()` form, with explicit state resets beforehand where the 6-arg form hard-coded `isAccredited=false`, `accreditation=null`, etc. Match the pattern landed in FE-ORCID-CALLBACK-FIXES re-review (once that task's fixes land).

## Non-goals

Redesigning `_saveSession`'s signature. Centralizing the pre-save state-reset into a helper (fold if/when a fourth user surfaces).

## Deliverable

Move to Review with per-site regression tests asserting the safe-default fields land in localStorage.

## Architect re-review (2026-05-04) — HELD PENDING FIXES

Round-1 `/ce-code-review` on commit `748e1ac`. The 3-site conversion landed cleanly and the pre-save state assignments mirror the 6-arg form's hard-coded defaults. Two test gaps surfaced.

1. **P1 — Test ordering blindness on the load-bearing invariant** (testing × 2 + learnings, anchor 100). The two new specs in `frontend/tests/unit/pages-signup-verify.test.js:255-345` and the upgrade spec in `frontend/tests/unit/pages-settings.test.js:143-182` each have inline comments claiming to lock in "expiresAt MUST be set BEFORE `_saveSession()` reads from it". But assertions on `mockAuthStore.expiresAt` run AFTER `await comp.submitCreateAccount()` / `await comp.executeUpgrade()` returns. They observe FINAL state, not state-at-call-time. A future refactor moving `auth.expiresAt = res.data.expires_at` to AFTER `auth._saveSession()` passes every test while re-introducing the exact "stale prior expiresAt persisted, user logged out on reload" bug. Fix: replace `_saveSession: vi.fn()` with a snapshot-capturing stub:
   ```js
   let savedSnapshot;
   mockAuthStore._saveSession = vi.fn(function () {
     savedSnapshot = { ...mockAuthStore };
   });
   // ...
   expect(savedSnapshot.expiresAt).toBe('2099-12-31T00:00:00.000Z');
   expect(savedSnapshot.token).toBe('jwt-create');
   ```
   The snapshot inspects what `_saveSession` would persist *at the moment it was called*, locking in the ordering invariant. Apply across all three new specs.

2. **P2 — No test for explicit `expires_at: null` branch on settings.js upgrade** (testing, anchor 75). Guard `if (result.data?.expires_at)` covers three input shapes: present, omitted, explicit null. Existing tests cover present + omitted. A future refactor like `if ('expires_at' in result.data)` would treat explicit null as truthy-key-present and assign null to `auth.expiresAt`, silently logging users out. Add a third spec in the existing describe block:
   ```js
   it('preserves existing expiresAt when backend response has expires_at: null explicit', async () => {
     // backend returns { data: { token: 'new-jwt', custody: 'self', expires_at: null } }
     // assert mockAuthStore.expiresAt === originalExpiry (preserved, not clobbered)
   });
   ```

Both items are pure test improvements; no production code change. Implementer should be able to land both in one focused commit.

**Path to re-archive:** (1) UI agent applies items #1 + #2. (2) `git mv` to `tasks/review/`. (3) Architect runs round-2 `/ce-code-review` on the test-file delta and archives.

## UI re-review signal (2026-05-04, working tree)

Round-1 hold items #1 + #2 landed across `frontend/tests/unit/pages-signup-verify.test.js` and `frontend/tests/unit/pages-settings.test.js`. Pure test improvements; no production code changed. Ready for architect round-2.

- **Item #1 (snapshot-capturing `_saveSession` stub):** applied to all three full-state specs that have the "expiresAt MUST be set BEFORE _saveSession() reads from it" load-bearing comment.
  - `pages-signup-verify.test.js` `submitCreateAccount > sets full auth state including expiresAt before calling no-arg _saveSession()` — assertions now read `savedSnapshot.<field>` (state-at-call-time), not `mockAuthStore.<field>` (final state). Fields covered: token, username, isConnected, isAccredited, accreditation, custody, expiresAt.
  - `pages-signup-verify.test.js` `handleLinkAccount > sets full auth state including expiresAt before calling no-arg _saveSession()` — same migration. Fields covered: token, username, isConnected, isAccredited, accreditation, custody='self', expiresAt.
  - `pages-settings.test.js` `executeUpgrade > calls no-arg _saveSession() with full auth state set on the store first` — same migration. Fields covered: custody='self', token, expiresAt, isAccredited, accreditation. The `expect(mockAuthStore._saveSession).toHaveBeenCalledWith()` zero-arg assertion is preserved at each site.
  - The stub form `mockAuthStore._saveSession = vi.fn(function () { savedSnapshot = { ...mockAuthStore }; })` matches the architect's example. Each spec declares a local `let savedSnapshot;` and adds an `expect(savedSnapshot).toBeDefined();` sanity check before the field assertions.
  - Mutation-kill check: a refactor moving `auth.expiresAt = res.data.expires_at` (or any other pre-save assignment) to AFTER the `_saveSession()` call now flips `savedSnapshot.expiresAt` to the seeded initial value (e.g. `null` in pages-signup-verify, `'2099-01-01T00:00:00.000Z'` in pages-settings) at call time, failing the assertion. The previous final-state form passed against this regression.
- **Item #2 (explicit `expires_at: null` branch):** new test `preserves existing expiresAt when backend response has expires_at: null explicit` in the `FE-SAVESESSION-API-MISUSE-SWEEP: executeUpgrade` describe block, immediately after the existing "omits expires_at" spec. Backend response is `{ data: { token: 'new-jwt-null-expiry', custody: 'self', expires_at: null } }`. Asserts `mockAuthStore.expiresAt === originalExpiry` (preserved). A regression to `'expires_at' in result.data` would clobber expiresAt to null and fail. Production guard `if (result.data?.expires_at)` correctly handles null since `null` is falsy.
- Verified: `npx vitest run tests/unit/pages-settings.test.js tests/unit/pages-signup-verify.test.js` → 78/78 (49 + 29; +1 new explicit-null spec); full frontend unit suite → 1026/1026.

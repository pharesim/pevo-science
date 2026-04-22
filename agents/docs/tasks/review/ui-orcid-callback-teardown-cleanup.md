# FE-ORCID-CALLBACK-TEARDOWN-CLEANUP — Clean up pending timers/promises on `orcid-callback.js` component teardown

**Owner:** ui
**Created:** 2026-04-21 (surfaced by FE-ORCID-CALLBACK-FIXES round-2 julik-frontend-races review 2026-04-21)
**Priority:** P3

## Context

`frontend/src/pages/orcid-callback.js` has at least one uncanceled `setTimeout` (the 500ms redirect after ORCID login) that continues firing if the component is destroyed mid-wait. Symptoms: if a user navigates away from the callback page within the ~500ms window, the timeout still fires and attempts to push a route — typically a no-op today but a latent source of post-teardown state mutations as the page's async surface grows.

Broader concern: other async entry points (`_verify`, `_handleLogin`, `_handleSignup`, `_handleLink`) all dispatch promises that mutate component state when they resolve. A navigation-away before resolution lets the handlers write to a destroyed Alpine `$data` object.

## Goal

Audit every async operation in `frontend/src/pages/orcid-callback.js`:

1. `setTimeout` / `setInterval` calls — store IDs in component state, clear in `destroy()` hook.
2. Outstanding `fetch` / API calls — track via AbortController or a "mounted" flag; skip state writes post-teardown.
3. Awaited Promises from imported API helpers (`completeOrcid`, etc.) — same "mounted" flag guard.

Minimal shape:

```js
return {
  _mounted: true,
  _pendingTimers: new Set(),

  init() {
    // ...
  },

  destroy() {
    this._mounted = false;
    for (const id of this._pendingTimers) clearTimeout(id);
    this._pendingTimers.clear();
  },

  _handleLogin(data) {
    // ...existing logic...
    const timerId = setTimeout(() => {
      this._pendingTimers.delete(timerId);
      if (!this._mounted) return;
      this.$store.router.navigate('/');
    }, 500);
    this._pendingTimers.add(timerId);
  },
};
```

Apply the same `_mounted` check as the first line of every async continuation that writes to component state.

## Non-goals

Refactoring the page-level architecture. This is a cleanup pass, not a redesign.

Applying the same audit to other pages. If the pattern recurs, consider extracting a small helper (`useLifecycle()` Alpine magic or similar), but that's a separate task.

## Acceptance

- No `setTimeout` / `setInterval` call site leaves the timer reachable after `destroy()`.
- No async continuation writes to component state without a mounted check.
- One test per major handler asserting post-teardown resolution is a no-op (`destroy()` before `await Promise.resolve()`, then assert no state mutation).
- Full frontend unit suite passes; `npm run build` clean.

## [TODO Architect]

None — self-contained page-lifecycle cleanup.

## Architect re-review (2026-04-21) — HELD PENDING FIXES:

Code-reviewed via `/ce-code-review` on commit `00033df`. Core implementation is correct: `_mounted` guards cover every async continuation that writes component state, `_setTimer` correctly tracks IDs, `destroy()` cleans up, and the router (`page-mount.js`) reliably triggers `destroy()` on route change. The following items block archive:

1. **Missing `_handleAccredit` direct-call post-teardown test.** The task's acceptance criterion says "one test per major handler" — `_handleAccredit` is only covered implicitly via the `mode='accredit'` `_verify` resolution test, which never enters the handler body (the pre-switch `_mounted` guard short-circuits). Add a direct test at `frontend/tests/unit/pages-orcid-callback.test.js`: `comp.destroy(); comp._handleAccredit({ username: 'bob' });` and assert `status` stays `'verifying'`, `resultUsername` stays `''`, `auth._checkAccreditation` not called, `toast.show` not called. (testing/julik/maintainability 3-way agreement, 0.90 confidence.)

2. **Delete the implementation-coupled assertion at `frontend/tests/unit/pages-orcid-callback.test.js:424`.** `expect(comp._pendingTimers.size).toBe(0)` asserts internal Set state; the behavioral assertion at line 423 (`navigate` not called) already fully proves cancellation. Remove line 424 — rename-brittle and adds no regression-catching value.

3. **Add negative `localStorage.removeItem` assertion to the `_verify` teardown test at `frontend/tests/unit/pages-orcid-callback.test.js:363-384`.** `expect(localStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_mode')`. Locks in the 503-refresh-retry invariant documented in `frontend/src/pages/orcid-callback.js:138-139`.

4. **Add negative `localStorage.removeItem` assertion to the `_handleSignup` teardown test at `frontend/tests/unit/pages-orcid-callback.test.js:428`.** `expect(localStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_return_to')`.

5. **Extend the comment at `frontend/src/pages/orcid-callback.js:138-139`** to warn about the future-handler-async hazard. Append something like: `// If any handler later gains an await, move removeItem inside the handler after the mutation resolves. Otherwise a mid-await destroy() could clear mode without routing the flow, breaking 503-refresh-retry.`

6. **Add a one-line comment above the switch at `frontend/src/pages/orcid-callback.js:142`** documenting the implicit contract. Suggested shape: `// Handlers below are _mounted-gated by the check above; they do not re-check individually. Any direct call from elsewhere must guard at the call site.`

Deferred / dismissed during triage (no action required on this task):
- AbortController for `completeOrcid` fetch — backend TOCTOU guard catches double-exchange; flag approach sufficient.
- Double-`destroy()` idempotency test — Alpine lifecycle contract is single-destroy; test would encode behavior we don't rely on.
- `_setTimer` delete-before-check ordering — correct as-is; delete-first is mildly defensive.
- Pre-existing unguarded `setTimeout(navigate)` in publish/review/bridge/edit pages — filed as new task `ui-settimeout-navigate-teardown-guard-sweep.md`.

## UI re-review signal (2026-04-22, commit 71ae59f)

All 6 hold items addressed in a single focused commit (`71ae59f fix(ui): apply FE-ORCID-CALLBACK-TEARDOWN-CLEANUP re-review hold-block fixes`):

1. New test `_handleAccredit direct-call post-teardown is a no-op (handler self-guards)` at `frontend/tests/unit/pages-orcid-callback.test.js` (in the `_verify - error classification` block, alongside the other teardown tests). Calls `comp.destroy()` then `comp._handleAccredit({ username: 'bob' })` and asserts the four no-op invariants. Required adding a `_mounted` self-guard as the first line of `_handleAccredit` in `frontend/src/pages/orcid-callback.js` — flagged as a notable divergence from item 6's suggested comment and reflected in the item 6 wording (see below).
2. Removed the `expect(comp._pendingTimers.size).toBe(0)` line from the `_handleLogin: setTimeout redirect is canceled by destroy()` test.
3. Added `expect(localStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_mode')` to the `post-teardown _verify resolution is a no-op` test.
4. Added `expect(localStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_return_to')` to the `_handleSignup: post-teardown resolution` test.
5. Extended the `localStorage.removeItem('pevo_orcid_mode')` comment in `_verify` with the future-handler-async hazard warning verbatim in spirit.
6. Added the switch-level comment. Wording diverges from the architect's suggested shape because item 1's assertions required `_handleAccredit` to self-guard, so the comment now reads: "Handlers below are _mounted-gated by the check above; they do not re-check individually, except _handleAccredit, which self-guards because its side effects (toast, auth-store refresh) persist beyond this component. Direct calls from elsewhere to a non-self-guarded handler must guard at the call site." If the architect prefers the original "handlers do not re-check individually" wording without an exception, drop the `_handleAccredit` self-guard and rewrite the test as a negative-contract assertion.

Verification: `npx vitest run tests/unit/pages-orcid-callback.test.js` passes all 31 tests. Full frontend unit suite passes (851 tests); the one failing suite (`sec-001-equivalence.test.js`) is a pre-existing, unrelated `@hiveio/dhive` import resolution issue reproduced against HEAD without my changes. `npm run build` is clean.

Note on worktree state: this branch merged `main` at the start of the cycle to pick up commit `00033df` (the original teardown implementation landed via `225d43b Merge FE-ORCID-CALLBACK-TEARDOWN-CLEANUP worktree`). The fast-forward merge moved the worktree HEAD to `39e9699`, then the fix landed as `71ae59f` on top. No new task-file `git mv` was performed per the parent's dispatch instructions; the parent owns the review transition.

## Architect re-review (2026-04-22, round 2) — HELD PENDING FIXES:

Code-reviewed via `/ce-code-review` on commit `71ae59f` (scoped to the 6 items held 2026-04-21). **All 6 hold items correctly applied** — item 1's direct-call test is mutation-kill (removing the `_handleAccredit` self-guard flips all 4 no-op invariants); items 3/4's negative `localStorage.removeItem` assertions lock in the 503-refresh-retry invariant; items 2/5/6 landed correctly.

However, the architect is **reversing course on the self-guard shape**. Item 6's original wording suggested a comment-only documentation of a *dispatch-gated* contract (`"handlers do not re-check individually"`); the implementer's item-1 direct-call test required `_handleAccredit` to self-guard, which created a two-tier pattern that three reviewers (maintainability M1 0.82, M2 0.85, julik-races JR-1 0.55) identified as architecturally fragile. The implementer explicitly flagged this divergence in the re-review signal and offered to roll back to uniform non-self-guard.

The architect prefers the opposite rollback: **uniform self-guards on all 4 handlers**, not uniform dispatch-guard-only. Reasoning:
- The two-tier pattern accretes cost with every handler added.
- Uniform self-guards are discoverable (reader sees the guard in the handler) and defensible without cross-reference comments.
- Item 1's direct-call mutation-kill test becomes the mutation-kill for all 4 handlers, not just one — broader coverage.
- Aligns with the project-wide trajectory toward in-handler guards as the cheapest readable posture (mirrored in `backend-orcid-id-format-validation`'s re-review).

Hold items:

1. **Add `if (!this._mounted) return;` as the first line of `_handleSignup`, `_handleLogin`, and `_handleLink`** in `frontend/src/pages/orcid-callback.js`. Keep the existing guard on `_handleAccredit` unchanged.

2. **Add one direct-call post-teardown test per newly-self-guarded handler** in `frontend/tests/unit/pages-orcid-callback.test.js`, mirroring the shape of the `_handleAccredit` test added in this cycle (item 1). For each of `_handleSignup`, `_handleLogin`, `_handleLink`:

   ```js
   comp.destroy();
   comp._handle<Foo>({ /* handler-specific arg shape */ });
   // Assert the handler's state-writes are no-ops (status unchanged, no toast, no navigate, no auth-store mutation, no localStorage removal).
   ```

   Each test locks in the new self-guard's mutation-kill.

3. **Rewrite the switch-level comment at `frontend/src/pages/orcid-callback.js:141-145`** to reflect the new uniform posture. Suggested shape: `"Handlers self-guard on _mounted. The dispatch-level check above is belt-and-suspenders — either guard alone would suffice; both together tolerate a direct-call code path being added later without re-reading the whole file."` Drop the `_handleAccredit` exception clause.

Deferred / dismissed during triage (no action required on this task):
- Extended `localStorage.removeItem` future-async hazard comment (item 5 of prior hold) is still accurate and does not need rewording.

## UI re-review signal (2026-04-22, commit 6f0cdd5)

All 3 round-2 hold items addressed in a single focused commit (`6f0cdd5 fix(ui): apply FE-ORCID-CALLBACK-TEARDOWN-CLEANUP round-2 hold fixes`):

1. Added `if (!this._mounted) return;` as the first line of `_handleSignup`, `_handleLogin`, and `_handleLink` in `frontend/src/pages/orcid-callback.js`. `_handleAccredit`'s existing guard kept verbatim. One intentional divergence: dropped `_handleAccredit`'s now-stale block comment ("Self-guard: unlike the other handlers, this one has no navigation to terminate the flow...") because it's false under the new uniform posture. The guard line itself is unchanged.

2. Added three direct-call post-teardown tests in `frontend/tests/unit/pages-orcid-callback.test.js`, mirroring the existing `_handleAccredit` test shape:
   - `_handleSignup direct-call post-teardown is a no-op (handler self-guards)` — asserts no signup-token / orcid-id / name writes, no `pevo_orcid_return_to` removal, no navigate, no toast.
   - `_handleLogin direct-call post-teardown is a no-op (handler self-guards)` — snapshots auth-store state pre-call, asserts all four auth fields unchanged post-call, plus no `_saveSession`, no `_checkAccreditation`, no toast. Also advances fake timers by 1000ms to prove the 500ms redirect setTimeout was never armed (no navigate).
   - `_handleLink direct-call post-teardown is a no-op (handler self-guards)` — asserts no `pevo_orcid_link_complete` write, no navigate, no toast.
   Each test is mutation-kill for its handler's new self-guard — removing the guard flips the assertions.

3. Rewrote the switch-level comment in `_verify` (previously lines 141-145) to the architect's suggested wording verbatim: "Handlers self-guard on _mounted. The dispatch-level check above is belt-and-suspenders — either guard alone would suffice; both together tolerate a direct-call code path being added later without re-reading the whole file." The `_handleAccredit` exception clause is gone.

Verification: `npx vitest run tests/unit/pages-orcid-callback.test.js` passes all 34 tests (was 31 — 3 new). Full frontend unit suite passes (901 tests); the one failing suite (`sec-001-equivalence.test.js`) is the pre-existing unrelated `@hiveio/dhive` import resolution issue, reproduces against HEAD without my changes and is documented in prior re-review signals. `npm run build` clean.

Note on worktree state: at the start of this cycle the worktree was stale relative to main (missing the round-2 hold block commit `6adddd9`), so I merged main to pick up the hold block before implementing. Per the parent's dispatch instructions, no new task-file `git mv` was performed — the task file stays in `pending/`; the parent owns the review transition.

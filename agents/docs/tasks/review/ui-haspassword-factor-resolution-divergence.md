# Reconcile the hasPassword re-auth factor resolution across surfaces

**Owner:** ui
**Created:** 2026-08-27

Routed out of the architect review of `e9512840` (light-account re-auth window).
Not held on that task: the code it landed is on the *correct* side of this
divergence, and the surfaces that need changing are outside its scope.

## Why

Four places independently resolve whether an account has a password, and they
disagree about what to do when the answer is unavailable. The re-auth factor a
user is offered therefore depends on which surface they happen to be on.

- `lib/fresh-auth.js` (`accountHasPassword`): only an explicit `hasPassword === false`
  routes to ORCID. An unknown or failed status falls through to the password
  prompt and lets the backend reject a genuinely passwordless account.
- `lib/settings-fresh-auth.js` (`usesPasswordFactor`): returns
  `action !== 'set_password' && hasPassword`, so a falsy value routes to ORCID.
- `pages/settings.js`: reads `hasPassword === true` strictly, and on a failed
  status fetch substitutes `{ hasEmail: false, custody: 'self', hasPassword: false }`.
- `pages/admin.js`: initialises `hasPassword: false` and sets
  `hasPassword: emailRes?.data?.hasPassword === true`.

So one transient `fetchEmailStatus` failure sends a state-B user to a password
modal on publish and to a full-page ORCID redirect on change-email. The redirect
is the destructive branch: it discards page state, which is precisely what the
window work set out to stop doing to people.

`fresh-auth.js` has the posture the project wants. The others predate it.

## Scope

1. Make one resolver canonical. `accountHasPassword` in `lib/fresh-auth.js` is
   the natural home; it already memoises per username for the tab. Have the
   settings, admin, and settings-fresh-auth paths consume it rather than each
   fetching and caching their own answer.
2. Reconcile the failure direction to the password-prompt posture: only an
   explicit `false` may route to ORCID. Unknown, failed, or absent falls through
   to the password prompt and lets the backend reject.
3. Preserve the one legitimate exception: `set_password` targets a null-hash
   account by definition, so ORCID is its only registered factor regardless of
   what the status says. Keep that branch, and make it read as the deliberate
   exception it is rather than as a case of the general rule.

## Acceptance criteria

1. Exactly one function in the frontend resolves `hasPassword` for factor
   selection; the settings, admin, and settings-fresh-auth surfaces call it.
2. With `fetchEmailStatus` failing, a state-B user attempting change-email gets
   the password prompt, not an ORCID redirect.
3. `set_password` still routes to ORCID for a passwordless account.
4. The memo cannot be inherited across a logout and re-login as a different
   account (it is username-keyed today; keep that property under the unification).

## Notes

Consider clearing the memo in `auth.disconnect()` alongside the window cache
while in the area. It is username-keyed so cross-account inheritance is not
reachable, but a stale positive can outlive the only transition that drops a
password (`recover(orcid, no new_password)`, which moves B to C per
`ARCHITECTURE.md` § 6.3). That transition runs through a real navigation today,
which resets module state, so this is tidiness rather than a live bug.

---

**UI implementation note (2026-08-31):**

Landed at `5cd378dc` (+ a comment-tightening follow-up commit).

Scope grew by one surface. The task enumerates four resolvers; the code had
five. `pages/paper-detail.js` carried its own `_hasPassword` lazy memo
(`=== true` strict, `catch → false`) feeding `withAuthorshipFreshAuth`, whose
falsy branch is `beginAuthorshipOrcidFreshAuth` — the same destructive
full-page redirect, on the surface where losing page state costs the most.
It is included in the unification.

What landed:

- `accountUsesPasswordFactor()` in `lib/fresh-auth.js` is the single resolver.
  It owns the status fetch, the per-username memo, and the failure direction
  (`hasPassword !== false`), so the unknown-status fallthrough is decided in one
  place rather than restated per consumer. The old private `accountHasPassword`
  tri-state is gone; `acquireSessionProof` consumes the new predicate.
- The `hasPassword` field is removed from the fresh-auth ctx entirely. Settings,
  admin, and paper-detail pass `{ custody, username }` only, so those surfaces
  can no longer diverge on factor selection — they do not participate in it.
  `admin.js` no longer fetches the email status at all (import dropped);
  `paper-detail.js` no longer imports `fetchEmailStatus`, and `_authCtx()` is
  now synchronous.
- Both orchestrators (`settings-fresh-auth.js`, `authorship-consent.js`) call
  the resolver at BOTH the initial mint and the 401 retry gate, so those two
  cannot drift from each other either.
- `set_password` keeps its ORCID-only branch, restated as the deliberate
  exception: it short-circuits before the resolver is consulted, so the account
  status is never read for it.
- `auth.disconnect()` calls the new `clearPasswordFactorMemo()` alongside the
  proof caches (the task's Notes suggestion).

Acceptance criteria:

1. One resolver, consumed by settings / admin / settings-fresh-auth — and also
   by authorship-consent and paper-detail. Verified by grep: the only
   `hasPassword` reads left in `frontend/src/` are inside the resolver itself
   and `settings.js`'s rendering of the set-a-password section, which is not
   factor selection.
2. Covered at both layers. Lib: "an unavailable account status falls through to
   the password prompt, never the ORCID redirect" and its authorship sibling.
   Page: settings' "hands the orchestrator custody and username only, even when
   the status fetch failed", which drives the real `loadEmailStatus()` failure
   fallback first.
3. Covered by "an unavailable status still leaves set_password on the ORCID
   factor" and "set_password never consults the account status at all", plus the
   pre-existing ORCID-only cases. The E2E `settings-orcid-factor.spec.js`
   real-backend-minted-proof round-trip passes.
4. Covered by the `password-factor memo` describe block in
   `lib-fresh-auth-session-window.test.js` (positive memoized once, negative
   re-checked, different username not inherited, explicit clear, failed status
   never memoized) plus `auth.test.js` "drops the password-factor memo on
   disconnect".

Verification:

- `npx vitest run` — 78 files, 1665 tests, all pass. The 3 `pages-edit.test.js`
  unhandled rejections (`$refs.abstractEditor`) reproduce on a stashed tree and
  are unrelated.
- `npm run build` clean.
- E2E on a freshly reset `pevo_app_test`, `settings.spec.js` +
  `settings-orcid-factor.spec.js` + `authorship-consent-actions.spec.js` +
  `non-consent-fresh-auth.spec.js`: **10 passed / 1 failed**. The same batch on
  a clean DB at the parent commit gives the identical **10 passed / 1 failed**,
  failing the same test, so there is no regression.

Pre-existing failure worth its own triage (NOT introduced here, and not fixed
here): `settings-orcid-factor.spec.js` "the fresh_auth callback caches the proof
under (set_password, username, '')" asserts the cached consent-op entry deep-
equals a five-field object, but `cacheConsentOpProof` has written
`authorIndex: null, claimer: null` since the per-slot credit-op cache extension
(`90fc5d2d`). The spec's assertion is stale, not the code.

One adjacent issue left alone, flagged for triage: `settings.js`
`loadEmailStatus()` still substitutes `{ hasEmail: false, custody: 'self',
hasPassword: false }` when the status fetch fails. That no longer affects factor
selection, but it does drive RENDERING — a failed fetch shows the "set a
password" section to an account that may already have one. Changing what the
page renders on a failed fetch is a separate decision from factor resolution, so
it is out of this task's scope.

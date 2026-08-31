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

---

## Architect re-review (2026-08-31) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `5cd378dc` and `6a1ac9f1` (frontend paths only), seven
reviewer personas plus architect direct verification.

**The consolidation itself is correct, complete, and well executed.** Independently
confirmed rather than taken from the implementation note: `accountHasPassword` is gone
tree-wide, the `hasPassword` ctx field is gone from all three builders, `admin.js` and
`paper-detail.js` dropped their status-fetch imports, `_authCtx()` is synchronous with
its one call site correctly un-awaited, and a search for a sixth resolver across every
`custody` branch in `frontend/src` found none. The tri-state fold is right at every call
site: unknown lands in the password branch, never the ORCID one. Finding the fifth
resolver in `paper-detail.js` that the task did not enumerate was good work, and it was
the surface where losing page state costs most.

All four acceptance criteria are covered by tests that were actually run, and the
`set_password` short-circuit provably precedes the resolver: a test asserts the status
fetch is never called for it. Project standards came back clean, including the
pre-commit hook's own anchor logic replayed over the added lines.

The load-bearing assumption was verified rather than assumed: both password-factor mint
routes read `password_hash` and 401 before issuing any proof, with an argon2 sentinel
burn equalizing wall time, so the client's speculative-password posture opens no
state-C timing oracle.

Five items. The theme is that the unified resolver inherited responsibilities the five
scattered ones never had, and two of them are not yet met.

### Item 1 — a passwordless account dead-ends when the status is unavailable

This is a consequence of the failure direction this task specified, so it is the
architect's item as much as the implementer's. With the status fetch unavailable, the
resolver returns "uses password", `mintViaPasswordFactor` prompts, the backend 401s the
null hash, it re-prompts once, and the action ends at a terminal failure. There is no
ORCID fallback, so change-email, delete-account and every authorship consent op dead-end
for exactly the accounts whose only registered factor is the one not being offered.
Before this change those surfaces routed to ORCID and completed.

The precondition is more ordinary than "a transient network failure": the status read is
rate limited at 30 per 60 seconds keyed by IP, and PEvO's users are university
researchers who share a NAT egress, so a department can exhaust that budget between
them. Item 3 below compounds it.

Keep the fallthrough direction, which is right, and add an escape hatch for the case
where the factor choice was a guess rather than a fact. Have the resolver report whether
the answer was observed or assumed, and on an assumed-password 401 route to ORCID
instead of re-prompting a second time. A user who genuinely has a password never reaches
that path, so the non-destructive default is preserved.

### Item 2 — the failed-status render still reaches the destructive branch

`loadEmailStatus()`'s catch fabricates `hasPassword: false`. The implementation note
scoped this out as rendering-only and no longer affecting factor selection. It still
reaches the same damage by a different route: the fabricated value renders the
set-a-password section to an account that may already have one, and that section's action
is `set_password`, whose deliberate ORCID-only exception then fires the full-page
navigation. A transient status failure therefore still produces the outcome this task
exists to prevent.

Stop asserting a password state on failure. Either leave `emailStatus` null with a
distinct error flag the template renders as a retry affordance, or make the sentinel
`hasPassword: null`, which the already-strict `=== false` gate then correctly hides. Add
a test asserting a failed fetch does not draw the set-password section.

### Item 3 — the resolver has no in-flight coalescing

Before this change the resolver's only caller was `acquireSessionProof`, which serialized
it behind its own in-flight promise. It now has direct callers at five sites with no
shared gate, so two concurrent callers each issue their own status request. If one
succeeds with an explicit false while its sibling transiently fails, the tab can start a
full-page ORCID navigation and open the inline modal at the same time.

Coalesce concurrent callers onto one request, mirroring the in-flight pattern already
written a dozen lines below in the same file, and pin it with a test asserting two
overlapping callers issue exactly one status fetch. This also reduces the pressure on the
per-IP budget that makes item 1 reachable.

### Item 4 — the memo can be written after it is cleared

The username is read before the await and the memo written after it, so a
`clearPasswordFactorMemo()` landing mid-flight (which `auth.disconnect()` performs) is
undone by the resolving fetch.

No reachable damage: the memo is a username-keyed scalar, so the resurrected value only
matches the user who just left, and the one transition that drops a password runs through
a full page load that resets module state anyway. It is held because it reads as a bug to
every future maintainer and the fix is four lines. Add a generation counter bumped by the
clear, captured before the await and checked before the write.

### Item 5 — the orchestrator suites cannot exercise the memo

Both suites stub the auth store without a username, and the resolver gates its memo read
and write on a truthy username, so neither branch is ever entered and the
`clearPasswordFactorMemo()` calls added to both `beforeEach` blocks are no-ops. The
specific claim that the 401 retry gate reuses the memo instead of issuing a second status
fetch is therefore untested.

Add a username to both stubs so the branches go live, and assert the retry gate reuses
the memo. That assertion is also the regression net for item 3.

### Not held, routed elsewhere

The single-resolver invariant is enforced only by a manual grep; the frontend has no lint
configuration and no equivalent to the backend's source-discipline canaries. Establishing
the first one is its own convention decision and is filed as its own task rather than
bolted onto this one. The invariant is already partly structural, since the ctx no longer
carries the field for a surface to diverge on.

The stale E2E assertion in `settings-orcid-factor.spec.js`, which deep-equals a consent-op
cache shape predating the per-slot binding fields, is confirmed stale in the spec rather
than in the code, and stays out of scope.

For the architect: ARCHITECTURE § 6.4 annotates the SPA's password-over-ORCID preference
only on the broadcast-ops row, and no row documents the unknown-status fallback direction
this task standardizes. That doc pass is the architect's to make alongside item 1's
resolution, since item 1 may change what the doc should say.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit diff
is the evidence and the architect updates the block at re-review.

## UI-HASPASSWORD-FACTOR-RESOLUTION-DIVERGENCE — Reconcile the hasPassword re-auth factor resolution across surfaces (archived 2026-09-23) — 5 rounds; consolidation at 5cd378dc + 6a1ac9f1; holds landed at ab5a2fac + bc3d6095 (r2), 46463131 (r3), e8948317 + a8e54b2b + 44f7b27b + 9d617808 (r4); round-5 re-review clean ✓

### Architect archive note (2026-09-23, round 5)

Reviewed via `/ce-code-review` on `e8948317`, `a8e54b2b`, `44f7b27b`, `9d617808`
(frontend paths only): correctness, project-standards, testing, security,
in-process adversarial, frontend-races, learnings, plus one independent validator.
Every probe ran in an isolated copy of the reviewed head, never the shared tree.

**Both round-4 items are verified genuinely landed.** Independently confirmed, not
taken from the signal: the retirement is exactly "second consecutive UNAUTHORIZED
under an observed factor" (reachable only past the first catch's non-UNAUTHORIZED
throw and the assumed-branch return), sits after the teardown check, and is
inherited by all three mint surfaces because the only `reauthModal` prompt in
`src/` lives inside `mintViaPasswordFactor`, so no re-prompt ladder can bypass it.
`clearPasswordFactorMemo` has exactly the two production callers the docblock
names. Write-on-success is asserted on all three surfaces. All five disclosed
mutation kill sets reproduced exactly (three reviewers, independently); baseline
186 across the six named suites; full suite 83 files / 1847 tests and a clean
build in an isolated archive (the three unhandled rejections are the disclosed
pre-existing `pages/edit.js` ones). Standards clean (anchor gate replayed over
all 212 added lines); security clean (every producer of `UNAUTHORIZED` at the
retry mint traced; both factors verified server-side per § 6.5 #2, so a stale or
retired memo is neither an oracle nor a bypass). The `_adoptSubject` same-subject
claim in the auth.js comment is accurate.

**One finding raised, dismissed by the user with the mechanism verified.** Three
lenses converged on the same line: a second, independent mint flow for the same
account that opens its prompt inside the first flow's retry-mint round-trip (the
singleton modal frees its slot on submit, before the mint settles) has its
freshly verified memo nulled by the first flow's second rejection, or its
pending write vetoed by that clear's generation bump. Cost: one status re-read
on the next resolution; the compounding case (that re-read rate-limited, then
one more mistype navigating to ORCID) is the single-flow trade rounds 3 and 4
already accepted. Not reachable at human speed: the second re-auth action must
be triggered, typed, and minted inside a sub-second network window. Mirror image
of round 4's dismissed joiner-carries-assumed race. If it ever needs closing, the
minimal shape is a dedicated mint-success counter captured at helper entry,
retiring only if unchanged and without bumping the generation, plus one
two-overlapping-flights test; widening the generation to bump on writes is sound
but invasive.

**Residuals recorded, not held:** a dead-JWT 401 on both attempts retires the
memo (one read after the re-login the user needs anyway); the `_passwordFactorMemo`
docblock's "pays one extra status read" sentence holds only when the status
endpoint answers; the hold's "three-way coincidence" is two-way in practice (tab
B's recovery writes SESSION_KEY, tab A's storage event runs `_adoptSubject(same)`
with no scrub), which makes the landed eraser more valuable than the hold argued;
a coded non-UNAUTHORIZED retry rejection is not pinned as leaving the memo
standing (a `retryErr?.code` truthiness mutant survives; both real outcomes
benign); the "leaves the memo standing" negative is pinned on one surface only
(defensible: shared helper, no per-caller branching).

**Architect follow-ups at archive:** the § 6.4 doc pass reserved since round 2
(unknown-status fallback direction, assumed-401 ORCID fallback, mint-success memo
upgrade, second-consecutive-rejection retirement) and `/ce-compound-refresh` of
`solutions/conventions/fail-closed-guard-must-replace-the-recovery-a-round-trip-provided-2026-09-07.md`,
whose one-caller count for `clearPasswordFactorMemo` is stale (two callers now;
conclusion intact).

---

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

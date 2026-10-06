## The accreditation verify page posts the token without a session (archived 2026-10-06) — one round; clean after one in-place comment fix; ORCID copy gap and cross-tab post dismissed; backend half unblocked

### Architect archive note (2026-10-06, round 1)

- **Review:** `/ce-code-review` on `9e853eea~1..8f9a082a` (correctness, security, adversarial in-process, testing, frontend races, project-standards, learnings; validator on the two merged findings). No P0/P1. The full frontend unit suite on a git-archive copy of `8f9a082a`: 92 files, 2179 tests, exit 0, matching the signal. Testing planted 11 mutants: 9 killed; the two survivors (the `SIGN_IN_CODES` branch moved below `_isRetriable`; the `_mounted` guard in `handleConnect` dropped) dismissed as low-risk. Two lenses traced the page's states (8 real-Alpine scenarios, 5 named race scenarios): no double post, loop, stuck `loading`, lost token, or POST without a session.
- **#1 (P2, dismissed):** the sign-in modal's ORCID line navigates to `/login` in the same tab and ORCID login lands on `/papers`, so the captured token is lost, and `verify.signInMessage` does not say to open the link again. The signal's "which the sign-in copy already asks for" is false: only `verify.mismatchMessage` says it. Dismissed on reachability: an account that requests email accreditation signs in inside the modal (light signups are accredited by the `/confirm` and `/link` accreditation cascade in `signup-verify.ts`; pure self-custody accounts have no ORCID login), so only an off-path click on the ORCID line reaches it.
- **#2 (P3, fixed in place by the architect, `faffe9f9`):** deleted "Each comes before the token is read, so" from the `SIGN_IN_CODES` docblock. `/verify` has no auth middleware yet, so the server-side ordering described the backend task.
- **#3 (advisory, dismissed):** a sign-in in another tab also posts the captured token; the watcher comment names that case. Until the backend task lands this is narrower than the old post-on-load; after it, a sign-in as the wrong account gets the mismatch state.
- **Noted, no action:** two tabs in the sign-in state both post on one sign-in, and `/verify` has no per-token lock, so near-simultaneous posts may both broadcast (backend concern). Testing gap on the code strings is covered by the backend task's AC1/AC2 plus the unblock note appended to it.
- **Sibling drift:** `64bca0fb` and `141840d7` (other ui tasks: mailbox-bound and sanctioned states, timeout naming, copy) landed on the verify page and its spec after the reviewed head; not part of this review.
- **[TODO Architect] done:** `backend-accreditation-verify-requires-the-account-session` moved `blocked/` → `pending/` with an unblock note naming the codes the page matches.
- **Learnings checkpoint:** existing entries grepped for the verify page and route symbols; the `skip-failed-requests-jwt-required-credential-verify-carve-out` grid row for `accreditationVerifyLimiter` (JWT-required ❌) still holds until the backend task lands, and no entry claims the page posts on load. No new entry: the adopted-session re-post rationale is carried by the comment in `_verify` and by `_endSession` in `auth.js`.

**Owner:** ui
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 4).

## Why

`POST /api/accreditation/verify` takes the emailed token as its only credential. Whoever opens
the link accredits the account that requested it, under the name the requester typed. A requester
can name someone else's institutional address, and `accreditationVerifyPage.init()`
(`frontend/src/pages/accreditation-verify.js`) posts the token as soon as the page loads.

**Decision (user, 2026-10-05):** `/verify` will require the session of the account the link was
requested for. The backend half is `backend-accreditation-verify-requires-the-account-session`,
which waits in `blocked/` until this task is archived: if the backend landed first, this page's
unauthenticated POST would answer 401 and the page would show its generic failure state.

This task is compatible with the backend as it stands. The route has no auth middleware today, so
it ignores an `Authorization` header.

## Scope

1. `verifyAccreditation` (`frontend/src/api.js`) sends the session. It uses the plain `request`
   helper today; `requestAccreditation`, next to it, uses `authenticatedRequest`.
2. The page does not post while no session exists. It shows a state that says the link has to be
   opened while signed in as the account that requested the accreditation, and offers the app's
   existing sign-in entry point (`frontend/src/components/sign-in-modal.js`). After a sign-in on
   that page it goes on with the token it captured in `init()`. The session is kept in
   `localStorage`, so a link opened in a new tab of a browser that is already signed in has it.
3. Two answers the backend task will add, both leaving the token usable:
   - 401 (`UNAUTHORIZED`, or the session-ended codes `authenticatedRequest` already handles):
     show the sign-in state, not "Request New".
   - 403 `ACCREDITATION_ACCOUNT_MISMATCH`: say that the link belongs to a different account and
     that the user should sign in as that account and open the link again. No "Request New"
     button on this state.
4. New copy goes through the i18n flow the other pages use.

## Out of scope

- How the page maps the other error codes. `architect-audit-frontend-security-surface` covers
  this file.
- A confirm click before posting. The session requirement was chosen instead.

## Acceptance criteria

1. With no session the page sends no request and shows the sign-in state. After sign-in it posts
   once, with the token from the URL.
2. With a session the POST carries the `Authorization` header.
3. A 403 `ACCREDITATION_ACCOUNT_MISMATCH` answer shows the different-account copy and no
   "Request New" button. A 401 answer shows the sign-in state.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- Move `backend-accreditation-verify-requires-the-account-session` from `blocked/` to `pending/`.

## UI implementation signal (2026-10-06, commits 9e853eea, 39439ca1, 8f9a082a)

Landed on main in three commits, each verified with
`git merge-base --is-ancestor <sha> main`:

- `9e853eea`: the two `form button[type="submit"]` locators in
  `accreditation.spec.js` scoped to `[x-data="accreditationPage"]` (decision 1).
- `39439ca1`: the change itself: `verifyAccreditation`, the page, the four
  `verify.*` keys in all sixteen locales, the STUBS.md sweep, and the unit and
  E2E specs.
- `8f9a082a`: three comments in the new specs narrowed to what the page does
  (verification findings, below).

**Decisions taken with the user before submitting:**

1. **Locator fold-in.** The request-and-verify E2E spec failed at its first
   click on the known strict-mode clash with the always-rendered re-auth modal
   form, so the Authorization assertion added to it never ran. Fixed in its own
   commit, the same fix `edit-paper.spec.js` received.
2. **Adopted session posts again.** On a `SESSION_EXPIRED` or
   `SESSION_INVALIDATED` answer the auth store can adopt a newer session another
   tab saved instead of signing out (`_endSession` ->
   `_adoptStoredSessionOtherThan`). The page would then show "Sign in" under a
   live session. `_verify` remembers the session token the request carried; in
   the sign-in branch, a different store token means the page posts again with
   it, and no token left means the sign-in state. A server `UNAUTHORIZED` with an
   unchanged token shows the sign-in state, so there is no loop. A newer session
   of another account lands on the mismatch state once the backend task is in.

**Scope 1 / AC2.** `verifyAccreditation` (`frontend/src/api.js`) goes through
`authenticatedRequest`. `api.test.js` asserts `Authorization: Bearer <token>` on
`POST /api/accreditation/verify`; both E2E flows assert the bearer header.

**Scope 2 / AC1.** `init()` captures the URL token, registers
`$watch('$store.auth.token')`, and calls `_verifyIfSignedIn()`. With no session
it shows the `signin` state (title, the "has to be opened while signed in as the
requesting account" copy, and a Sign in button calling `auth.connect()`) and
sends nothing. Any later session token while in that state (the page's button,
the header, another tab's storage event) posts the captured token once.
E2E "verify link opened without a session asks for sign-in, then posts with the
session" drives this through the real modal (Keychain path, `/api/auth/session`
stubbed with a minted JWT): zero requests before sign-in, exactly one after,
with the token from the URL and the new bearer.

**Scope 3 / AC3.** `SIGN_IN_CODES` (`UNAUTHORIZED`, `SESSION_EXPIRED`,
`SESSION_INVALIDATED`) map to the `signin` state, never to "Request New".
`ACCREDITATION_ACCOUNT_MISMATCH` maps to a `mismatch` state with its own title
and the different-account copy, and no button. E2E "verify link opened as a
different account shows the different-account state" asserts the copy and zero
"Request New Accreditation" links (the stubbed 403 carries a different message,
so the assertion would catch raw server text).

**Scope 4.** Keys `verify.signInTitle`, `verify.signInMessage`,
`verify.mismatchTitle`, `verify.mismatchMessage` in all sixteen locales, English
stubs in the fifteen others, listed under
`### Added 2026-10-06 (ui-accreditation-verify-page-signs-in-first)`. No emdash.

**AC4.** The pre-commit anchor gate passed on all three commits.

**Verification.**
- Unit: full frontend suite, `npx vitest run` exit 0, 92 files, 2179 tests.
- E2E (test-mode stack, bundle rebuilt from 39439ca1): `accreditation.spec.js`
  3/3 passed, including the formerly failing request-and-verify spec. `8f9a082a`
  is comment-only. Stack restored with `./deploy.sh up`.
- `/ce-simplify-code`: applied the watcher's redundant token check, the
  `vi.fn()` `$watch` idiom of `pages-edit.test.js`, and a distinct mismatch stub
  message. Skipped exporting `SESSION_ENDED_CODES` (would pull `fresh-auth.js`
  into the page and its api mock) and an E2E session-stub helper (two copies).
- Adversarial verification workflow (3 lenses, skeptic per finding) on
  39439ca1: 10 planned mutants plus 4 extra, all killed by a unit spec or, by
  reading, an E2E spec; a real-Alpine probe of 11 sign-in scenarios found no
  double post or loop. Two low findings confirmed and fixed in `8f9a082a`
  (comments stating the backend's session check as current, and that the
  mismatch state names the account).
- `/ce-code-review` not run: architect-owned per `agents/ui/CLAUDE.md`.

**Out of scope, for follow-up if wanted.**
- The sign-in modal's ORCID line navigates to `/login` in the same tab
  (decision on `ui-sign-in-modal-has-no-orcid-path`), so an ORCID sign-in from
  this page loses the captured token; the user opens the link again, which the
  sign-in copy already asks for. A skeptic refuted it as a defect of this task.
- `403 ACCREDITATION_SANCTIONED` from `/verify` still shows the generic failure
  with "Request New" (other-code mapping is out of scope here).

## A native edit never sends an empty body, and never copies another post's `continues` (archived 2026-10-06) — three rounds; round 2 added the served-body send rule (§ 8 rule 2), round 3 one comment narrowing; clean; two follow-ups filed

### Architect archive note (2026-10-06, round 3)

Round 3 clean (`/ce-code-review`, lite path: comment only, zero findings). `1d26e15e` is exactly the prescribed one-line narrowing of the `latestIsTarget` comment, and the comment is true on both `papers.ts` serving paths. AC1 to AC5 were met at round 1; round 2 landed the served-body send rule and the `targetOwnContinues` docblock narrowing.

- Follow-ups filed: `ui-edit-no-change-guard-compares-served-authors` (normal), `ui-native-edit-continues-from-target-own-metadata` (low), both in `pending/`.
- Carried by `ui-composer-landing-wait-and-served-diff-base` (blocked): a non-head target whose own op is the latest sends the full body for an unchanged body; a stale cached detail can name an older latest op.
- Dismissed: `reconstructVersionsFromHaf` same-block ordering; the unpinned skip of a `versions[]` entry without `author`/`permlink`.
- Noted, no action: the round-3 hold's premise ("serves `latest.body` only when the chain holds more than one post") overlooks the metadata-restored fallback, which serves `latest.body` for a single post too. The comment carries no "only", so it stays true.
- Learnings: `/ce-compound-refresh` on `hafsql-comments-body-never-follows-an-edit-read-the-replay.md` (`6460d6ea`), whose "the detail always serves the creation body" the metadata-restored fallback contradicts. No new entry: the round-3 lesson (hold prose overclaims, then gets copied) is already recorded.

**Owner:** ui
**Created:** 2026-10-01
**Priority:** high

Two defects in the native-edit arm of `handleSubmit` in `frontend/src/pages/edit.js`, found
while deciding the composer retry-safety question. Neither depends on any other task. Read
`agents/docs/ARCHITECTURE.md` § 8, "What a native edit sends".

## Why

1. **An unchanged body is sent as `''`, and Hive rejects it.** On a head target the arm sends
   `broadcastBody = diffText.length >= newPostBody.length ? newPostBody : diffText`, and
   `computeDiff(a, a)` is `''`, so the empty string wins. hived's `comment_operation::validate`
   rejects an empty body ("Body is empty"), and nothing between the page and the node checks
   first. Measured with the real page: a title-only native edit broadcasts `body: ""`. The
   no-change guard does not stop it whenever another field changed, and it is skipped outright
   when supplementary files or addressed-review ticks are present, so attaching a file to one's
   own paper, or ticking the reviews a revision addresses without touching the text, also sends
   `''`. Every such edit ends in "Edit failed". Addressing reviews is a core PEvO flow.
2. **A native edit on a non-head post writes the head's `continues` onto its target.** The
   arm builds its metadata from `...pevoMeta`, where `pevoMeta` is
   `this.paper.json_metadata?.[APP_TAG]`, the metadata of the latest op across the chain. When
   the root author edits the root after a co-author's continuation became the head, that
   metadata is the continuation's, so the root's new op carries `continues` pointing at the root
   itself (measured with the real page). By read: `resolveContinuationChain` then finds the root
   as its own continuation, stops at its cycle guard and returns the root alone, and every
   listing, search, profile and reputation query filters `continues IS NULL`, so the paper drops
   out of all of them. No continuation exists on chain yet, so this has not happened; it will on
   the first non-head edit after one does.

## Scope

1. **No-op patch for an unchanged body.** When the patch computed for a head target is empty,
   send `@@ -0,0 +0,0 @@\n`. It was measured to leave the body unchanged in the backend's and
   frontend's `diff-match-patch` and in hivemind's pinned Python port (bases of 0, 1, 47 and
   70000 chars, and one with a non-BMP character). Leave the other branches of the send rule
   alone; the full-body cases in § 8 belong to a later task.
2. **A native edit's `continues` is its target's own.** Absent when the target is the root; for a
   continuation post, the post it already continues. Never the head's. The spread of the rest of
   `pevoMeta` (the paper-level fields such as the current IPFS document) can stay. The target's
   own predecessor is derivable from the chain order in `versions[]`, or readable from the
   target's last version through `fetchPaper(canonical, canonicalPermlink, <version_number>)`;
   pick one and say which in the signal block.

## Out of scope

- The full-body fallbacks, the diff base, retries and the head check in § 8. A later task covers
  them, after the backend serves the replayed body. Do not send the full body for the empty case:
  until that backend task lands, the form holds the creation body, and a full body built from it
  would silently revert every earlier edit.
- The continuation arm's own metadata (it sets `continues` to the head deliberately).

## Acceptance criteria

1. A head-target native edit whose body is unchanged broadcasts exactly `@@ -0,0 +0,0 @@\n`:
   for a title-only change, a supplementary-file-only change, and an addressed-reviews-only
   change.
2. A head-target native edit that changes the body still broadcasts a patch; the existing
   `head-author native edit still computes diff` spec stays green.
3. A non-head native edit's broadcast metadata carries no `continues` when the target is the
   root, and carries the target's own predecessor when the target is a continuation post. Change
   the fixture the non-head specs use (unit, and `frontend/tests/e2e/edit-paper.spec.js`) so the
   head's metadata carries a `continues`, so the assertion can fail.
4. Each assertion is probed by reverting its own site; list the probes in the signal block.
5. New comments follow root `CLAUDE.md` "Comment anchors".

## Implementation notes

**UI implementation signal (2026-10-05, commits `6e10bd5e`, `62812370`, `4648252e`, `bdefe550`; follow-up tasks `0498a574`, `59018357`; each verified an ancestor of `main` with the expected file list):**

- `6e10bd5e`: the fix, the new unit specs, and the e2e fixture change. `62812370`: the head-target continues spec reshaped to cover a root version listed between two continuations. `4648252e`: the seven `form button[type="submit"]` locators in `edit-paper.spec.js` scoped to `[x-data="editPage"] form button[type="submit"]` (user-approved fold-in: the always-rendered re-auth modal form made all seven specs fail at the click or at `toHaveCount(0)`, so the AC3 e2e assertion was never reached). `bdefe550`: the fixes from the review below.
- Scope 1 / AC1-2: the head-target branch sends `NO_OP_PATCH` (`@@ -0,0 +0,0 @@\n`) when `computeDiff` returns `''`; every other branch of the send rule is unchanged. Unit specs cover a title-only, a supplementary-file-only and an addressed-review-only edit. The `head-author native edit still computes diff` spec stays green and now also asserts the patch carries the change (`toContain('TWEAK')`), since the no-op patch also starts with `@@`; the e2e in-place spec gained the same check (`toContain('drift detection')`).
- Scope 2, the choice: the target's `continues` is derived from the chain order in `versions[]`, not read through `fetchPaper(..., version_number)`. `targetOwnContinues` puts the canonical root first (it continues nothing), then the other posts in the order of their first version, and returns the post before the target. When the response holds one post (a fork of an already-continued head, or a continuation whose PEvO block another frontend stripped, both served as papers of their own), the served metadata is that post's own, so its served `continues` is kept. Chosen for no network read, and no new failure path, inside the submit. The rule applies to every native edit, head or not: with the head excluded, a head continuation edited after a later root edit would have lost its `continues`, since the served metadata is then the root's.
- AC3: the unit non-head spec's served metadata is now parsed and names `continues`, and asserts the root sends none. New unit specs: a non-head continuation target sends its own predecessor; a head continuation target keeps its predecessor when the latest op is the root's (with a root version listed between two continuations); a continuation served on its own keeps its served `continues`; with a link whose first version is older than the root's, the root sends none and the link names the root. The e2e non-head fixture's served metadata now names `continues`.
- AC4 probes (unit probes in scratchpad copies of `bdefe550`, `tests/unit/pages-edit.test.js`, baseline 137 passed):
  - no-op site reverted to the old ternary: the three unchanged-body specs fail, nothing else;
  - `NO_OP_PATCH = ''`: the same three fail;
  - the else branch always sends `NO_OP_PATCH`: only `head-author native edit still computes diff` fails (on `TWEAK`);
  - `continues: targetContinues || undefined` deleted: the root non-head, continuation non-head, head-target and inverted-root specs fail (the fork and inverted-link specs pass because the served metadata happens to carry the right value there);
  - single-post branch deleted: only the fork spec fails;
  - canonical-root-first removed (`posts = []`): only the two inverted-chain specs fail;
  - de-duplication removed: the head-target spec and the fork spec fail.
  - E2E: with the `continues` line removed, the non-head spec fails at `expect(meta[APP_TAG].continues).toBeUndefined()`, receiving the root as its own `continues`; unmutated it passes (both served by vite dev from scratch copies carrying the backend's `__PEVO_CONFIG__`).
- AC5: the new comments anchor on `targetOwnContinues`, `NO_OP_PATCH` and the specs' fixtures; the commits passed the pre-commit anchor gate.

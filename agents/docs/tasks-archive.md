## Re-anchor the eight bare positional citations left in frontend/{src,tests} (archived 2026-10-05) — first review clean at 473af3f9; leftovers the regex cannot see routed to ui-positional-anchor-residue-sweep

### Architect archive note (2026-10-05)

First review of 473af3f9 with /ce-code-review (focused: correctness and root CLAUDE.md
"Comment anchors" in the architect context, plus one in-process adversarial reviewer
reading a scratchpad copy of the reviewed tree, because sibling ui commits had moved the
files since). No findings from either read. Every one of the eight rewrites (items 2 to 8
plus the off-list `UPLOAD_ERROR_TEXT` site in ipfs-upload.js) names exactly one target in
its file, and the sentence's claim about that target holds against the code. The
hook's positional regex returns 0 at 473af3f9 and at HEAD 9f2ddf96, against 8 at the
parent. No added line carries another rot form. Every changed line is a comment. Full
unit suite on an isolated copy of 473af3f9: 87 files, 1975 tests, exit 0, matching the
signal block.

User decision 2026-10-05: the "not in scope, for the architect to route" leftovers
(the line-wrapped `retryUpgradeBackend` "the guard / above just confirmed" form plus the
plural, counted and unlisted-noun forms) went to a new ui task,
ui-positional-anchor-residue-sweep. Widening the hook regex stays an architect decision
after that sweep. No /ce-compound: the per-line blind spot is recorded in that task and
in the hook's own deferred list.

### Task file

**Owner:** ui
**Created:** 2026-09-06

Routed out of the round-6 architect review of `ui-cross-user-session-teardown`
(clean, archived the same day). That task retired the last bare positional anchor
in `lib/fresh-auth.js`'s `beginOrcidFreshAuthRedirect` docblock, and its signal
block correctly reported that the wider class was still open. This is that class,
filed as its own task so it is not blocked behind two still-open sibling tasks.

## Why

`.githooks/pre-commit` gained a positional-anchor arm on 2026-09-06 (`85baa79b`).
It is a DIFF gate: it fires only on newly-added lines, so none of the citations
below trips it and none of them will until someone edits that line. Root
`CLAUDE.md` defers the whole-tree-clean guarantee for these trees explicitly, and
that deferral is why the lines survived. The cost of leaving them is that the
`frontend/{src,tests}` trees cannot be promoted to a whole-tree-clean gate, and
each line is live rot: an insertion between the citation and its target silently
breaks the pointer with nothing to catch it.

The governing convention is
`agents/docs/solutions/conventions/positional-anchor-stable-named-container-carve-out-2026-05-20.md`.
A positional citation is durable ONLY when a stable behavioral name rides along in
the same container. All eight below are bare: the article sits directly against a
structural noun with no name in the slot.

## Scope

Re-anchor these eight, enumerated from the tree on 2026-09-06 by running the
hook's own positional regex over `frontend/src` and `frontend/tests`. Each is
quoted by its phrase rather than only its line number, since the numbers drift:

1. `tests/e2e/non-consent-fresh-auth.spec.js` - "is covered by the test above"
2. `tests/e2e/orcid-no-password.spec.js` - "See the docblock above the real round-trip describe"
3. `tests/unit/lib-fresh-auth-settings-orcid.test.js` - "The case above passes none"
4. `tests/unit/lib-fresh-auth-settings-orcid.test.js` - "The control for the case above"
5. `src/pages/settings.js` - "now that the guard above has already established"
6. `src/lib/fresh-auth.js` - "here and the call below"
7. `tests/unit/auth.test.js` - "The pair-partner of the test above"
8. `tests/unit/lib-settings-fresh-auth.test.js` - "The observed-factor sibling of the case above"

Item 6 deserves a judgment call rather than a reflex edit. Its full sentence is
"nothing may be awaited between here and the call below", and `mintViaPasswordFactor`
is named in the same comment paragraph, so a stable name arguably already rides
along and only the gate's noun-slot heuristic (which cannot see across a sentence)
would flag it. Decide it on the carve-out's three criteria and record the reasoning
in the commit message either way. A defensible "left as durable" is an acceptable
outcome for that one; the other seven are not.

For items 1 and 2, check whether the cited target is even in the same container
before rewriting. An e2e citation pointing across `describe` blocks needs the
target restated, not renamed.

## Acceptance criteria

- The hook's positional regex returns zero matches over `frontend/src` and
  `frontend/tests`, OR returns only item 6 with the carve-out reasoning recorded.
- Every replacement is audited against the other anchor rules per
  `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`:
  no task slug, round ordinal, line number, SHA, or `tasks-archive` redirect
  substituted for the position. This is the failure mode the convention exists for.
- Each rewrite is checked for behavioral accuracy against the code it describes,
  not just for anchor shape. A citation that is re-pointed at the wrong target is
  worse than the bare positional form it replaced.
- Comment-only. No production or test behavior changes, and the frontend unit
  suite stays at its documented baseline.

## Notes

Five of the eight belong to tasks still open in `tasks/pending/` at filing time
(`ui-consent-op-teardown-guard`, `ui-custody-upgrade-subject-pin`). Coordinate
rather than racing them: if either task is mid-flight on one of these files when
this is picked up, take the other files first and leave a note here. Items 1 and 2
predate both and have no other owner.

## Note (2026-09-14, from the light-account fresh-auth e2e task)

Item 1 no longer exists: the closing note in `tests/e2e/non-consent-fresh-auth.spec.js`
that carried "is covered by the test above" was replaced wholesale at 58ad7918, and the
hook's positional regex returns nothing over that file, the new
`tests/e2e/consent-op-fresh-auth.spec.js`, or `tests/e2e/fixtures/light-account.js`.
Seven items remain.

UI implementation signal (2026-09-30, commit 473af3f9):

Landed in `473af3f9` (verified an ancestor of `main`). Seven files, comment-only.

- The hook's positional regex returns zero matches over `frontend/src` and
  `frontend/tests`. Item 6 is not left as a carve-out: the sentence now reads
  "between this re-check and the `mintViaPasswordFactor` call", so no exemption
  is needed. The reasoning is in the commit message.
- Eight sites were re-anchored, not seven. Items 2 to 8 of the filed list, plus
  one the enumeration predates: `src/lib/ipfs-upload.js` "the table above",
  now `UPLOAD_ERROR_TEXT`. Item 1 was already gone per the 2026-09-14 note.
- Item 2 stays inside one file but points across describe blocks from the file
  header, so the target is restated by the describe's title
  ('real-backend ORCID null-password round-trips') rather than by position.
- Each rewrite was checked against the code by an independent read-only pass
  told to refute it. Seven held. One did not: "the assumed-password 401 case" in
  `lib-settings-fresh-auth.test.js` matched three cases in that file, so it now
  reads "the assumed-password 401 that lands after a subject change". Two
  over-long re-wraps were reflowed in the same pass.
- Frontend unit suite: 87 files, 1975 tests, exit 0 on two consecutive runs. One
  earlier run failed only `lib-fresh-auth-session-window` "the slide never
  pushes past the absolute cap" by 1ms, the known boundary flake.

Not in scope, for the architect to route: the zero-match result is a statement
about the hook's regex, not about the trees. A sweep for what the per-line,
article-adjacent regex cannot see found one listed-noun form split across a
line wrap (`src/pages/settings.js`, retry leg, "the guard" / "above just
confirmed") and roughly 65 plural, counted or unlisted-noun forms ("the two
tests below", "the assertion below", "every step below", "see below"), densest
in `src/pages/settings.js` and the e2e specs. Promoting these trees to a
whole-tree-clean gate would need those swept and the regex widened first.

## Align the custody column with upgraded_at at upgrade and login mints (archived 2026-10-05) — five holds; archived at cca00888, one P3 folded into the custody-canary hold

### Architect archive note (2026-10-05)

Round-6 re-review of cca00888 alone with /ce-code-review (full: correctness, adversarial
in-process, testing, project-standards on root CLAUDE.md, learnings) plus an independent
validator. Both round-5 items are met. The handleLogin state-C sentence is true clause by
clause: `/custody/fresh-auth` and `/custody/session-auth` each refuse a NULL `password_hash`,
and `/custody/upgrade` reads only `upgraded_at`. The STATEMENT_JOIN_CAP pair pins the value
in both directions, reproduced independently by two lenses: cap 3 reds the fourth-joined
assertion, caps 5 and 12 red the fifth, deleting the join term reds the fifth; baseline 8/8.

One finding (P3, confirmed by the validator): the JOIN docblock's cost sentence names only
the epoch derivation, but the cap also bounds the column copy and destructure scans (a
one-per-line destructure with three or more members before `custody` escapes at cap 4). User
decision 2026-10-05: folded into the backend-custody-canary-unpinned-surfaces hold as item 4
(c6ce08ce) instead of a sixth hold here. A learnings note on a possible off-by-one in "more
than four joined lines apart" was measured and not admitted.

Items surfaced in earlier backend signals that no hold had taken up were triaged with the
user ("approved", 2026-10-05): section 6.3 gained the state-G transitions here, and the
stale A/B/C/D code comments plus the set-password NULL-hash comment went to
backend-account-state-comments-name-state-g; /reset gating on no account state went to
backend-password-reset-gates-on-account-state; the state-D JWT settings question went to
ui-state-d-session-settings-critical-actions (reproduce first); the registration-watch
state-G webhook item was dismissed as already recorded in the collectCompleted docblock.
All three filed at 94975a70.

[TODO Architect] doc items discharged at 89d896ce. The canonical epoch-ordering statement
lives in section 6.3's new "Option C lookup predicates" note, not 6.7 as the round-4 block
said, because the discriminator moved off the revocation epoch onto
`upgraded_at <= updated_at`; 6.7 got a pointer bullet. Also: 6.1 states the CHECK is
one-directional and the (self, NULL epoch) shape is fictional and refused; 6.4's
set-password and Link ORCID rows match the handlers; auth.md documents the /confirm and
/link cookie-free stuck-recovery branches; orcid.md states the derived login custody for D
and G; custody.md says /upgrade marks the row self-custody. The deploy-tripwire ADD
CONSTRAINT arm, state G in 6.1, and the state-F anchor fix landed during earlier rounds.
No /ce-compound: the finding is an instance of the existing
a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each convention.
Implementation commits: 68fc1e91, c5846d1a, 9fd22a7f, 65ab1c74, f0effeb1, a24aae5a, cca00888.

### Task file

**Owner:** backend
**Created:** 2026-09-01

Routed out of the architect review of the custody-upgrade session-invalidation
work. Pre-existing: the shape predates that task and was not widened by it.

## Why

`POST /api/custody/upgrade` nulls the encrypted keys and sets `upgraded_at`
but never writes `custody = 'self'`, so every upgraded account sits in the row
shape `(custody = 'light', upgraded_at NOT NULL)` — a combination
ARCHITECTURE.md § 6.1 does not enumerate. The two login mints then disagree
about what that row means: `auth.ts` login derives the JWT custody claim from
`upgraded_at` (correct), while the ORCID login mint reads the column raw and
re-mints a stale `custody: 'light'` claim for an account the server can no
longer sign for.

Impact is contained today: the broadcast and session-auth routes refuse on
`upgraded_at` before acting, so the stale claim is a divergence of claim
rather than a live hole. But per the account-state defense rule, an
unenumerated reachable state means the code and § 6.1 must be reconciled, and
two mint sites deriving the same claim differently is exactly the kind of
split that turns into a hole when a third consumer trusts the claim.

## Scope

1. Write `custody = 'self'` in the upgrade UPDATE's SET list (mirroring the
   signup-verify `/link` finalize), so the transition lands atomically with
   the key-nulling and the epoch stamp.
2. Backfill existing rows: `custody = 'self'` where `upgraded_at IS NOT NULL
   AND custody = 'light'` (SQL migration).
3. Unify the login-mint derivation: either both mints derive from
   `upgraded_at` the way `auth.ts` does, or both read the now-correct column —
   pick one shape and state why in the code. The pair must be incapable of
   disagreeing for the same row.
4. Tests: an upgraded account logging in via ORCID receives a `custody:
   'self'` claim; the post-upgrade row shape is pinned; the backfill is
   covered by a migration-level assertion or an equivalent test.

## Acceptance criteria

1. No reachable row shape `(custody = 'light', upgraded_at NOT NULL)` after
   the migration runs.
2. Both login paths mint identical custody claims for the same account row,
   pinned by a test that would fail if either derivation drifts.
3. The upgrade route's own suite still passes, including the
   session-invalidation legs.

## Notes

- **[TODO Architect]** § 6.1's state D row shape (and any state-table text
  that describes the custody column post-upgrade) is architect-owned and will
  be updated at archive to match whichever shape lands.
- Sequencing: CLEARED (2026-09-02, architect). This asked to land after a
  one-line comment fix the custody-upgrade session-invalidation work held in
  the same file area (`verifyHiveSignature.ts` / `routes/custody.ts`). That
  fix landed and its task is archived, so nothing remains to sequence behind
  and the five held items below can be picked up directly.

## Backend completion notes (2026-09-02)

Landed in `68fc1e91` (implementation), `c5846d1a` (review fixes, task to
review/), and `9fd22a7f` (simplification pass on the migration). Per scope
item:

1. The upgrade UPDATE writes `custody = 'self'` in the same statement as the
   key-nulling, `upgraded_at`, and the revocation epoch. `updated_at` is
   deliberately not bumped (it is the `/link` stuck-recovery recency marker

# Drive a light-account fresh-auth broadcast and upload end to end in the e2e suite

**Owner:** ui
**Created:** 2026-09-06

Routed out of the architect round-4 review of `ui-consent-op-teardown-guard`. Filed to
give the fresh-auth unit suites a clause-c real-path companion that actually exists: four
of them currently cite one that does not cover what they claim, and a fifth surface (the
authorship consent-op e2e spec) discharges clause (c) by pointing at this task.

## Why

Root `CLAUDE.md`'s "Carve-out for deterministic edge-case coverage" permits mocking only
when, among other things, clause (c) holds: the same risk class is covered by a real-path
test elsewhere, OR a follow-up task is filed to add such coverage. Four unit suites
discharge that clause by citing `frontend/tests/e2e/non-consent-fresh-auth.spec.js`:

- `lib-ipfs-upload.test.js` — "exercises upload + broadcast against the real backend"
- `fresh-auth-401-retry.test.js` — "exercises broadcastWithFreshAuth against the real
  backend for the happy path and the window-reuse path"
- `lib-fresh-auth-session-window.test.js` — "exercises acquisition + broadcast against the
  real backend"
- `lib-fresh-auth-outcome-dispatch.test.js` — "exercises acquisition against the real
  backend"

That spec contains exactly one test. It route-stubs `/api/orcid/callback` and asserts the
`session_auth` handler caches the issued window in sessionStorage. It drives no broadcast
and no upload. Its own closing note records the second test — a real vote through the
paper-detail page — as prototyped and removed, because the production bundle does not
expose `lib/fresh-auth.js` for dynamic import and the paper-detail mount needs more
fixture surface (full enrichment shape, paper-card data, accreditation polling stubs) than
a wire-contract assertion was judged to be worth. That note closes by naming the follow-up
this task is: drive the comment-composer path with full fixture data.

So the acquisition half of those citations is defensible and the broadcast and upload
halves are not. The risk classes left with no real-path companion are the ones the mocked
suites exist to cover: a window proof actually reaching `/api/custody/broadcast`, and a
window rejected between the IPFS pre-flight and the transfer.

There is no mechanical backstop. `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`
resolves citations under `backend/tests/` only, so a frontend suite can cite a spec that
does not cover it indefinitely without any check failing.

## Scope

1. Add e2e coverage that drives a light account through a fresh-auth broadcast with a
   proof attached, against the real backend. The comment-composer path is the shape the
   removed prototype's note recommends: it needs less fixture surface than paper-detail,
   and a comment is a real `custody/broadcast` with a session-window proof.
2. Add e2e coverage for the upload leg on the light-account path, where a window proof IS
   involved (`publish.spec.js` drives the upload endpoint only on self-custody, where none
   is). The window-rejected-mid-flight retry does not need to be reproduced; exercising the
   integrated path with real infrastructure is what clause (c) asks for, not mirroring the
   mocked assertion.
3. Add e2e coverage for the light-account **consent-op** leg: one authorship consent
   action (`author_accept` or `author_resign`) broadcast with a target-bound consent-op
   proof attached, against the real backend. This is a distinct mechanism from legs 1
   and 2, not a variant of them: the consent-op proof is minted by
   `mintAuthorshipFreshAuthProof` at `POST /custody/fresh-auth` and cached under
   `CONSENT_OP_PROOF_KEY`, while the session window is minted by `mintSessionAuthProof`
   at `POST /custody/session-auth` and cached under `SESSION_PROOF_KEY`. Per
   `ARCHITECTURE.md` 6.4.1 a session-window proof is rejected on the consent-op surface
   with `kind_mismatch`, so legs 1 and 2 cannot cover this risk class however thoroughly
   they are built. `frontend/tests/e2e/authorship-consent-actions.spec.js` is the header
   that depends on this leg.
4. Point the five headers at whatever this task actually lands, and drop the claims it
   does not support. Coordinate with the header corrections landed on
   `ui-consent-op-teardown-guard`, which discharges clause (c) through this task in the
   interim. While in `lib-fresh-auth-session-window.test.js`, correct its two stale
   "one case ... reaches the real upload module" statements: two `it()` blocks drive the
   real upload module, not one.

If either leg proves impractical for the same reason the earlier prototype was removed,
record that finding in this file and say plainly in the headers that no real-path
companion exists for that risk class. A stated gap is honest; a false citation is not.

## Acceptance criteria

1. At least one e2e spec drives a light-account operation that attaches a session-window
   fresh-auth proof to a real backend request, and asserts the request carried it.
2. At least one e2e spec drives the light-account upload leg against the real upload
   endpoint with a window proof.
3. At least one e2e spec drives a light-account consent-op broadcast that attaches a
   target-bound consent-op proof to a real backend request, and asserts the request
   carried it. A session-window proof does not satisfy this criterion.
4. The clause-c paragraph in each of the four unit suites named above, and in
   `frontend/tests/e2e/authorship-consent-actions.spec.js`, resolves to a spec that
   genuinely exercises the risk class that suite mocks, or states the gap explicitly.
5. No suite's clause-c paragraph names a spec that does not cover it, and no suite
   discharges clause (c) by citing a filed follow-up whose planned proof kind cannot
   apply to that suite's surface.
6. `lib-fresh-auth-session-window.test.js` no longer states that one case reaches the
   real upload module.

## Notes

Clause (c) does not require the companion to assert what the mocked test asserts. Root
`CLAUDE.md` is explicit: the companion "does NOT need to assert the same thing as the
mocked test, only to exercise the integrated path with real infrastructure so a different
mutation class is caught." A thin but genuine end-to-end path satisfies it; a thorough
mocked one does not.

Worth considering while in here, but not required by this task: whether the backend
citation canary should grow a frontend counterpart. Nothing currently prevents a frontend
suite from citing a spec that does not exist at all.

## UI implementation signal (2026-09-14, commits 58ad7918 and 306d84f4)

Both commits verified as ancestors of `main` with `git merge-base --is-ancestor`.

**What landed.**

- `frontend/tests/e2e/non-consent-fresh-auth.spec.js` (rewritten): the existing ORCID
  callback test, plus three light-account tests against the real test-mode backend. A vote
  from paper-detail: real `POST /custody/session-auth` mint through the reauth modal, real
  `POST /custody/broadcast` carrying the window past the fresh-auth gate to the seeded
  account's posting-key stop, a tampered-proof control refused at the gate, and a replay
  accepted again (multi-use). A comment from the composer: same acquisition, request
  asserted unmasked, response pinned as today's pre-gate refusal (defect below). A publish
  with a PDF: window acquired at file selection, real `POST /ipfs/upload-token` consumes it
  (with a tampered-proof control), real `POST /ipfs/upload` returns a CID, and the broadcast
  request carries the same window and that CID.
- `frontend/tests/e2e/consent-op-fresh-auth.spec.js` (new): `author_accept` from the accept
  affordance, target-bound proof minted at the real `POST /custody/fresh-auth`, consumed at
  the real `POST /custody/broadcast` past the gated-op scan to the posting-key stop; the
  replay is refused as spent (401 expired) and a freshly minted session-kind proof is
  refused with 403 `kind_mismatch`.
- `frontend/tests/e2e/fixtures/light-account.js` (new): seeded light row (argon2 password
  hash, no posting key), reauth-modal and confirm-dialog drivers, post-gate-stop and
  gate-refusal assertions, `postTo`. `fixtures/paper-mocks.js` gains `buildPaper`,
  `installAuthedBootMocks`, and a `comments` stub option; `authorship-consent-actions.spec.js`
  imports them instead of local copies.
- Headers corrected to what the specs genuinely drive: the four suites this task names,
  `authorship-consent-actions.spec.js`, and three siblings that made the same now-false claim
  (`lib-authorship-consent.test.js`, `lib-fresh-auth-consent-op-eviction.test.js`,
  `lib-fresh-auth-teardown.test.js`).

**Why each leg stops where it does.** The seeded rows carry no encrypted posting key, so the
custody handler consumes the proof, reads the row, and refuses at the posting-key decrypt
(500 INTERNAL_ERROR, "Posting key not available"), the first refusal a fully seeded row can
reach past the gate. Nothing is signed and no Hive node is reached. The upload pre-flight
gates on HAF accreditation after the consume, so the publish test seeds its light row under a
HAF-accredited username (removed again in afterAll) and skips itself when HAF lists none.

**Test runs (test-mode stack, 2026-09-14).** `non-consent-fresh-auth.spec.js` (4 tests),
`consent-op-fresh-auth.spec.js` (1), `authorship-consent-actions.spec.js` (4): 9 passed,
0 skipped (HAF listed an accredited researcher, so the publish leg ran and pinned a real
CID). Touched unit suites: 188 tests passed at 58ad7918; the four re-amended at 306d84f4
passed again (121 tests).

**Acceptance criteria.**

1. Met by the vote test: a session-window proof on a real custody broadcast, the request
   asserted to carry it, the gate passed.
2. Met by the publish test: the window proof on the real upload-token pre-flight, then the
   real upload and its CID.
3. Met by the consent-op test: a target-bound proof on a real custody broadcast, the request
   asserted to carry it; the `kind_mismatch` control shows a session-window proof cannot
   satisfy it.
4. and 5. Met: every clause-(c) paragraph in the five named headers resolves to a spec that
   drives the risk class or states the gap, and the three sibling headers likewise. A grep of
   `frontend/tests` for "follow-up is filed", "prototyped and removed", and "none exists"
   finds no remaining stale citation of these specs.
6. Already satisfied before this task: the two "one case ... reaches the real upload module"
   sentences left `lib-fresh-auth-session-window.test.js` at 1c03368c, when the teardown
   cases were split into `lib-fresh-auth-teardown.test.js`, whose header says two cases
   drive the real upload module. Verified no such sentence remains.

Not done, optional per the Notes: a frontend counterpart of the backend citation canary.

**Surfaced defect (needs triage; backend zone).** `backend/src/routes/custody.ts` admits only
`comment`, `vote`, and `custom_json` on the custody broadcast, while every new post the SPA
builds (comment composer, publish page, review page, edit-page continuation post) bundles a
`comment_options` op for the rewards policy. The handler refuses the bundle with 403
FORBIDDEN, "Operation 'comment_options' is not allowed for custodial accounts", BEFORE the
fresh-auth gate. Both sides date from the initial light-accounts commit (92c2e6b6), so a
light account's comment, review, and publish have never worked through custody; votes and
the edit page's same-author native edit (a lone comment op) are unaffected. Reproduced
outside Playwright with a minted JWT: comment plus comment_options is refused in 4 ms with
no gate log line, while comment-only and vote-only bundles reach the gate. The comment test
pins the refusal as a positive assertion under a `known-defect` annotation; once the
allowlist admits the op (author and permlink bound to the bundled comment and the JWT
subject, plus a decision on server-side `percent_hbd` enforcement), that pin reddens and is
replaced by `expectPostGateStop`. No backend task was filed from this session (ui zone);
the architect should file one.

**Overlap with sibling ui tasks (a note appended to each).**

- `ui-non-consent-spec-header-overclaims`: Scope 1 (opening paragraph), Scope 2 (ORCID
  companion sentence), and Scope 4 (the six citing suites) are overtaken by the rewritten
  docblock; Scope 3 took the disclosure option (orcid-link's real-path test is named as
  environment-gated by its conditional skip); the skip-removal decision stays with that task.
- `ui-positional-anchor-sweep-frontend`: item 1 ("is covered by the test above") no longer
  exists; the closing note it lived in was replaced.

**Review.** An ultracode workflow ran three simplification personas and six review lenses
over 58ad7918 (its refuter stage was cut off by the session rate limit, so the findings were
hand-triaged). Applied at 306d84f4: the `test.fail` on the comment test replaced by unmasked
request assertions plus the positive pin; the upload pre-flight tampered-proof control; the
rewards-policy `percent_hbd: 0` asserted on both post bundles; the docblock corrections
listed in that commit message. Skipped as not worth the readability cost: parallelising the
two control requests, memoising the argon2 hash. `/ce-code-review` was deliberately not
invoked (the architect owns it at review intake). The Playwright teardown's
`IPFS_API_URL not set` warning is pre-existing (the local `.env.test` lacks the key), so
pinned test CIDs wait for the backend's 24h orphan cleanup.

---

## Architect note (2026-09-15) — a sixth header joins this family

`ui-fresh-auth-teardown-test-split` archived clean today and its split created a sixth
header of the family this task's scope item 4 and AC 4/5 enumerate:
`frontend/tests/unit/lib-fresh-auth-teardown.test.js`. Three independent review lenses
converged (confidence 100) on its clause-c paragraph being honest but tracked nowhere. It
states that no real-path companion exists for a subject scrub landing mid-acquisition, and
no filed task covers that risk class, which is the one disposition root `CLAUDE.md` clause
(c) does not offer.

The gap is not new. The pre-split `lib-fresh-auth-session-window.test.js` header already
said "none exists yet for this suite's risk class", so the teardown task was not held for
it. What the split changed is that the mid-flight-scrub class now has a header of its own
saying so, and this task is where the family's headers are tracked.

Fold into scope item 4 and AC 4: the teardown suite is the sixth header. Two dispositions
are open, and either closes this:

1. Add a scrub leg. Log in as one account, park an acquisition on the open re-auth prompt,
   log in as another account in the same tab, and assert the parked action ends as a clean
   cancel reported exactly once. This is a distinct mechanism from legs 1 to 3: those three
   assert that a proof reaches the backend, while this one asserts that an acquisition
   whose subject departed reaches nothing at all.
2. Apply this task's own stated-gap disposition ("If either leg proves impractical ...
   record that finding in this file and say plainly in the headers that no real-path
   companion exists for that risk class") and record the mid-flight-scrub class as accepted
   here, so the disposition lives in the task tree rather than only in a spec header.

The architect has not chosen between them; the implementer should take whichever the
fixture cost supports and say which, and why, in the signal block.

---

## Architect re-review (2026-09-28) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `58ad7918` + `306d84f4` (frontend paths only,
inspected at the pinned head; three touched files have since drifted on main and every
held item below was re-checked against main), seven reviewer personas plus a learnings
pass. **The review is clean at the primary tier and every acceptance criterion is
verified genuinely met.** Independently confirmed rather than taken from the signal:
every pinned envelope, ordering, and wire shape matches the real handlers (the
post-gate stop is the unique first post-gate refusal in `custody.ts`; the allowlist
403 fires before the gate as the docblock claims; the reason vocabulary matches the
backend's failure mapping); each tampered/replay/kind control reddens on its
advertised regression class, so no control passes vacuously; the seeded row matches
ARCHITECTURE § 6.1 state A on all six dimensions; clause-(b) claims hold
(`verifyHiveSignature` runs real on the Bearer path); and the eight corrected
clause-(c) headers are accurate at the reviewed head. The items below are small-item
polish; nothing architectural.

**Resolved by the architect, no implementer action (closes the 2026-09-15 note
above):** the sixth header's disposition is the stated-gap acceptance. The
mid-flight-scrub risk class has no real-path companion, `lib-fresh-auth-teardown.test.js`
says so honestly, and this task records that as accepted; no scrub-leg e2e will be
built. Scope item 4 / AC 4 are discharged for that header as-is.

**Also settled at triage (2026-09-28), context for item 1:** the absence of an
accreditation check on `POST /api/custody/broadcast` is design intent, now recorded in
ARCHITECTURE's "Accredited-Only Data Policy" write-gate bullet: light-account signup
gates on the same criteria accreditation uses, so every product-created light account
automatically qualifies, and the upload-token check is resource gating. Separately,
the surfaced allowlist defect is now filed as
`backend-custody-allowlist-comment-options`; the known-defect pin in the comment test
stays until that task lands.

### Item 1 — align the fixture's accreditation sentence with the settled rationale

`fixtures/light-account.js`'s module docblock states "the broadcast handler performs
no accreditation check" as a bare fact, which reads as a discovered gap. Extend the
sentence to carry the why, per the ARCHITECTURE write-gate bullet: signup already
establishes accreditation qualification for every product-created light account, so
the broadcast performs no accreditation check by design, and the upload pre-flight's
check is resource gating. Two sentences at most.

### Item 2 — cover the new password in global-teardown's trace credential scan

The scan pins the literal `E2eTestPass1`; the new `TEST_PASSWORD`
(`E2eFreshAuthPass1`) does not substring-match it. Both current specs disable traces,
so nothing leaks today; the gap is the backstop for a future importer of
`seedLightAccount` that forgets `test.use({ trace: 'off' })`. Add the one entry to the
scan list next to the existing known-test-password arm.

### Item 3 — narrow the gate-refusal reason lists to what is reachable

`expectGateRefusal` calls accept reason sets wider than the single reason the backend
can produce for that arrangement: the tampered vote control and the tampered
pre-flight control accept `['missing', 'expired', 'malformed']`, and the consent-op
replay accepts `['expired', 'missing']`. Two lenses traced the backend's failure
mapping: a tampered proof reads back as a lookup miss and a spent proof as expired,
both surfacing `expired`. Verify against `backend/src/lib/fresh-auth.ts` first, then
narrow each list to the reason(s) actually reachable, so a reason-classification
regression cannot hide inside the accepted set. Status and code pins stay as they are.

### Item 4 — the RUN_SUFFIX comment misstates the Playwright retry model

"a Playwright retry (which re-runs beforeAll but not module scope)" is wrong: a retry
runs in a fresh worker process, so module scope re-runs too. The retry index plus the
timestamp are what keep each attempt's seeded rows distinct. Reword in both spec files
that carry the comment.

### Item 5 — the consent header attributes SPA-external controls to the orchestrator

`lib-authorship-consent.test.js`'s clause-(c) paragraph reads as if the spent-replay
and kind_mismatch refusals exercise the orchestrator; they are driven through
Playwright's request fixture, outside the SPA, so the orchestrator's handling of a
refused consent-op broadcast still has no real-path companion. Reword to attribute
the controls to the backend surface and state that remaining gap explicitly. The
sentence survives on current main (the file drifted after the reviewed head), so
apply against main.

### Dismissed at triage, recorded

- The vote test driving `handleVote` via `page.evaluate` instead of clicking the
  rendered control: the wire-contract assertion is the point; affordance clicks are
  other specs' job.
- Migrating the four sibling specs' local seed/boot-mock copies onto the new fixtures,
  and consolidating the repeated docblock rationale: optional follow-up scope, not
  this task.

### Residuals accepted, recorded for the archive

The seeded light row (custody='light', no posting key) matches § 6.1 state A but is a
shape no production transition produces, so the post-gate-stop mechanism couples three
spec files to `custody.ts`'s defensive branch (loud failure direction). The publish
test's borrowed-researcher row leaks until the next reset if a run dies before
afterAll (test DB only, guarded by `assertTestDatabase`). The e2e layer induces no
`username_mismatch`, `target_mismatch`, or missing-proof refusal (backend integration
tests cover all three; the headers disclose the absences). The upload-token per-account
limiter can 429 under full-suite retries on the borrowed username. Seeded usernames
exceed Hive's 16-character format and pass only while no route validates shape.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit
diff is the evidence and the architect updates the block at re-review.

---

## UI re-review signal (2026-09-29, commit 1ebbb379)

All five items landed at 1ebbb379 (verified an ancestor of main with
`git merge-base --is-ancestor`). Six files, +51/-16, comment-dominant.

- **Item 1:** the fixture docblock's accreditation sentence now carries the settled
  rationale (the pre-flight check is resource gating; the broadcast omits the check
  by design because light-account signup gates on the criteria accreditation uses),
  citing ARCHITECTURE.md "Accredited-Only Data Policy". Same file, same reason: the
  TEST_PASSWORD comment's "distinct from the literal the scan hunts for" implication
  went stale the moment item 2 landed, so it now says the scan hunts both literals.
- **Item 2:** the scan gains its own `known fresh-auth test password` arm pinning
  `E2eFreshAuthPass1` (distinct label, so a leak report names which password class),
  listed in the teardown docblock. Proof-first: the new detection test in
  `global-teardown.test.js` was observed red against the unpatched scan, green after.
- **Item 3:** verified against `consumeFreshAuthTokenForSurface` before narrowing,
  as the hold asked: a tampered token is a proof-store lookup miss (`expired`);
  `malformed` fires only for a stored entry failing shape validation, which no
  request can write; `missing` requires an absent token; and the consent-op burn
  deletes from both storage tiers, so a spent replay is the same lookup miss. All
  three wide lists narrowed to `['expired']`; the `kind_mismatch` pin is untouched.
- **Item 4:** among this task's files the wrong comment existed only in
  `non-consent-fresh-auth.spec.js`; it is reworded there and the same corrected
  comment was added to consent-op's previously uncommented identical computation, so
  both spec files carry accurate text. Verified against installed Playwright 1.59.1
  (the dispatcher stops the worker on failure unconditionally; beforeAll re-runs in
  the new worker per its typedoc; `testInfo.retry` is hook-accessible). Out-of-scope
  finding for architect triage: five pre-existing specs (email-signup, login-email,
  password-recovery, settings, settings-orcid-factor) carry the same wrong
  "does NOT re-evaluate module scope" claim; untouched here.
- **Item 5:** the clause-(c) paragraph now attributes the spent-replay and
  kind_mismatch refusals to the backend surface, driven through Playwright's request
  fixture outside the SPA, and states explicitly that the orchestrator's handling of
  a refused consent-op broadcast (the freshAuthFailed outcomes and the 401
  re-mint+retry) has no real-path companion. Applied against current main.

**Verification (2026-09-29).** Unit: `global-teardown.test.js` 15 passed,
`lib-authorship-consent.test.js` 37 passed, both exit 0. E2E on the test-mode stack
(restart, test-db-up, test-up): `non-consent-fresh-auth.spec.js` +
`consent-op-fresh-auth.spec.js`, 5 passed, 0 skipped, exit 0. HAF listed an
accredited researcher, so the publish leg ran and the narrowed pre-flight control
fired for real; teardown unpinned the run's CID. Dev routing restored afterwards.
A six-lens adversarial verify pass (read-only workflow) refuted nothing; its
residual notes are pre-existing behavior, not this change (the scan reports one
label per trace file; the group-offset counter constrains future pattern sources
containing escaped parens).

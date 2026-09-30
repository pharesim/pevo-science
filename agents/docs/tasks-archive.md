## Drive a light-account fresh-auth broadcast and upload end to end in the e2e suite (archived 2026-09-30)

Architect archive note (2026-09-30, round 3): archived clean after three rounds. Re-reviewed
`1ebbb379` alone (an ancestor of `main`, six files under `frontend/tests`, +51/-16,
comment-dominant) with /ce-code-review at the pinned commit, since main had drifted past it:
correctness, project-standards on root `CLAUDE.md`, testing, adversarial in-process (no
different-model peer on this host) and learnings. No primary finding. All five items held
on 2026-09-28 are FIXED, and no later commit on main changed a sentence `1ebbb379` wrote.

- Item 1: the fixture docblock carries the by-design accreditation rationale in one
  sentence, matching ARCHITECTURE "Accredited-Only Data Policy" (the upload pre-flight
  check is resource gating; signup already establishes qualification).
- Item 2: the trace scan has its own `known fresh-auth test password` arm. Removing or
  relabelling the arm fails exactly the new unit test; no alternation shadowing, and the
  group-offset bookkeeping resolves the arm to its own label.
- Item 3: all three wide reason lists are `['expired']`. `consumeFreshAuthTokenForSurface`
  returns `expired` on any lookup miss before `validateStoredEntry`, the only `malformed`
  source, can run; `missing` needs an absent token. A spent consent-op replay is `expired`
  on every ordering traced (Redis up, Redis down, a flap at burn time, concurrent
  presentation). Exactly four `reasons:` call sites exist; the fourth is the untouched
  `kind_mismatch` pin. Status and code pins are unchanged.
- Item 4: both fresh-auth specs state the real retry model. Playwright 1.59.1's dispatcher
  stops a failed worker and runs the retry in a new one.
- Item 5: the `lib-authorship-consent.test.js` clause-(c) paragraph attributes the
  spent-replay and kind_mismatch controls to the backend surface and states that the
  orchestrator's handling of a refused consent-op broadcast has no real-path companion.

Verified independently: `global-teardown.test.js` 15 passed and
`lib-authorship-consent.test.js` 37 passed, exit 0, in an isolated copy at the commit. The
e2e claim (5 passed across both fresh-auth specs) was not re-run.

Dismissed at triage: (a) the scan arm, the unit-test input and the fixture's
`TEST_PASSWORD` are three independent copies of the literal, so rotating the fixture
constant would leave the arm stale with tests green (theoretical-only); (b) the consent-op
replay comment's "removed the entry from both storage tiers" is exact for the
Redis-available path the e2e runs, while under a Redis flap the spent-proof ledger refuses
instead, still as `expired`; (c) `consent-op-fresh-auth.spec.js`'s own clause-(c) sentence
calls itself the companion for "the orchestration" without the qualification the citing
unit header now carries (not false; the clause-(c) duty sits on the mocked suite's header);
(d) the same spec's bare "the broadcast handler performs no accreditation check" in its
clause-(a) paragraph (true, reads as the scope of the stub, and was not held at round 2).

Routed: the false retry-model comment surviving in six sibling e2e specs, and the
`scanTracesForSecrets` docblock listing specs that do not type `E2eTestPass1`, are filed as
`ui-e2e-retry-model-comment-sweep`.

Left open for the user, not decided here: (1) whether to extend the trace scan to the six
other typed password literals (every spec that types one sets `trace: 'off'`, so it would
be a backstop only); (2) the comment test's known-defect pin in
`non-consent-fresh-auth.spec.js` now reddens by design because backend `4cb4347b` admits
`comment_options`; the ui flip to `expectPostGateStop` is a `[TODO Architect]` routing row
on `backend-custody-allowlist-comment-options` and is to be routed at that task's review.

No /ce-compound entry: once the sweep task lands, the specs themselves carry the correct
retry model.

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

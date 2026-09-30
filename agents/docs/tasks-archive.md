## Four more fresh-auth docblock tallies disagree with the tree (archived 2026-09-30)

Architect review (2026-09-30): archived clean at round 2. /ce-code-review on c12eab4f
(correctness, project-standards, testing, learnings; no adversarial lens, the commit is
comment-only and every changed line is a `//` comment). Zero findings. All three round-1
hold items are closed and stand at HEAD: `evictUnnamedAcquisition` reads "every later
broadcast action"; the permissive-default control comment states the complement of the
publish and edit submit sequences; `toastLocalized` locates its third caller as the cancel
closure of `subjectTeardownGuard`. The one sentence past the item-2 scope lift (the mint-leg
recurrence comment in the test file) is accepted: same drift, same file, true as written.
Censuses re-derived from the tree: nine `broadcastWithFreshAuth` call sites (three
suppressed, six permissive), three `toastLocalized` callers, three `REMINTABLE_REASONS`
consumers, five `handleSessionInconsistency` call sites on three surfaces. No
vote/comment/review triple remains in either file.


**Owner:** ui
**Created:** 2026-09-28

Routed out of the semantic sweep in
`ui-fresh-auth-clear-and-site-counts-name-their-members` (in `review/`): the
sweep's lenses covered clears and acquisition-result consumers, and these
four sit in adjacent populations (retry gates, teardown callers, broadcast
call sites, corrupt-entry drops), so they were surfaced for triage rather
than fixed there. User triaged them into this task. All four are the class
`agents/docs/solutions/conventions/sibling-docblock-tallies-must-each-state-precisely-what-they-count-2026-09-09.md`
documents: a hand-maintained count or universal that drifted when a new
member joined its population, or that overquantifies read alone.

## Why

Each claim below was verified against the working tree by the origin sweep's
independent call-graph traces (two sweep agents and a reconcile-hunt agent
converged on all four).

1. **`REMINTABLE_REASONS` docblock: "the three retry gates".** The sentence
   says the constant is "shared by both fresh-auth orchestrators (settings +
   authorship consent ops) and the session-kind retry gate in
   broadcastWithFreshAuth below, so the three retry gates cannot drift on
   which 401 reasons are recoverable." The upload surface's session-window
   retry in `lib/ipfs-upload.js` imports and consumes the same constant: a
   fourth gate the enumeration and the purpose clause both miss.

2. **`handleSessionInconsistency` docblock: "all three fresh-auth
   orchestrators".** The caller set is four surfaces: the shared
   `consentOpFreshAuthRetryGate` (serving both `withSettingsFreshAuth` and
   `withAuthorshipFreshAuth`), `broadcastWithFreshAuth` (first attempt and
   retry legs), and the upload surface's torn-down handler in
   `lib/ipfs-upload.js`. The parenthetical about "surface-appropriate
   sentinel" shapes also omits the upload surface's shape: it throws a coded
   upload-session error rather than returning `FRESH_AUTH_REDIRECT_PENDING`
   or `{ sessionInconsistent: true }`.

3. **`acquisitionAborted` docblock: "the eight broadcast call sites".** The
   tree has nine `broadcastWithFreshAuth` call expressions: two in
   `components/vote-buttons.js`, two in `components/vouch-section.js`, two in
   `pages/edit.js`, and one each in `pages/publish.js`, `pages/review.js`,
   `components/comment-composer.js`. No counting scheme (per expression, per
   file) yields eight. Same population, same file: the census implied by
   `broadcastWithFreshAuth`'s own docblock sentence "the vote/comment/review
   call sites keep the permissive default" omits `vouch-section.js`'s two
   permissive-default sites; every stated fact there is true, but the two
   clauses read as a complete permissive-vs-suppressed partition and are not.

4. **`cacheSessionProof` comment: "matching every other corrupt-entry case in
   this module: drop the slot".** Defensible counterexample: the consent-op
   reader's `catch` in `getCachedConsentOpProof` swallows a JSON.parse
   failure (unparseable text in the consent-op key) and returns null WITHOUT
   removing the entry, while the session slot's `storedWindow` drops on the
   same corruption. Read as "every handled corruption branch drops" the
   sentence is true; read as "every corrupt entry gets dropped" it is not.

## Scope

Comment-only. No executable line changes, no test changes, suite count
byte-identical before and after. Per the sibling-tallies learning, prefer
naming members over restating a number ("A, B and C do X" cannot drift the
way "three sites do X" can), and never add a clause explaining why two
counts differ: make each sentence say precisely what it counts.

1. Rewrite the `REMINTABLE_REASONS` sentence to name its consumers,
   including the upload retry in `lib/ipfs-upload.js`, or to state the
   sharing without a numeral.
2. Rewrite the `handleSessionInconsistency` sentence to name the actual
   caller surfaces and extend (or reword away) the sentinel parenthetical so
   the upload surface's thrown-code shape is not silently absent.
3. Replace "the eight broadcast call sites" with a form that cannot rot on
   the next call site (the numeral has drifted once already): quantify
   without a census ("every broadcast call site keeps its one clean-abort
   branch") or name per-file members if the enumeration earns its keep. Fix
   the permissive/suppressed census in `broadcastWithFreshAuth`'s docblock
   the same way (its suppressed-side enumeration is exact; the permissive
   side should not read as a closed list while omitting members).
4. Scope the `cacheSessionProof` universal to what the code does: the
   explicit corruption BRANCHES all drop; the consent-op reader's parse
   catch is a swallow, not a drop. Reword the universal rather than
   annotating the exception from a distance. Do not change the catch itself;
   whether that swallow should become a drop is a behavior question outside
   this task.
5. Before landing, sweep the file for any other sentence counting these
   populations (retry gates consuming `REMINTABLE_REASONS`; callers of
   `handleSessionInconsistency`; `broadcastWithFreshAuth` call sites;
   corrupt-entry drops) and check each semantically, not by phrase. The
   origin task's sweep ran with different lenses, so this task's populations
   have not had their own exhaustive pass.

## Acceptance criteria

1. Every sentence in `fresh-auth.js` that counts or characterizes these four
   populations agrees with the code and with every other such sentence in
   the file, read in isolation.
2. No numeral-only tally remains for a population that has already drifted
   once (items 1-3); members are named or the count is removed.
3. The replacement text carries no line numbers, SHAs, task slugs, round
   ordinals, or bare positional anchors; `.githooks/pre-commit` passes on
   the staged diff.
4. Full frontend unit suite green with an unchanged count; `npm run build`
   clean.

## Notes

Checked during the origin sweep and found defensible as written, do not
reopen without new evidence: `WINDOW_OUTCOME_TOASTS`' "in one table so no
consuming site can drift" (reads as sites consuming that table, and the
now-precise `showWindowOutcomeToast` docblock directly below it names the
caller set); the `ensureSessionWindow` guard comment's "those two legs" (the
claim verifies against the code); `evictUnnamedAcquisition`'s "both writers
of that slot" (the behavioral claim verifies under the natural reading
writers = `cacheSessionProof` + `slideSessionWindow`).

## UI implementation signal (2026-09-29, commit 5cb292ba)

All scope items landed in commit 5cb292ba (comment-only, fresh-auth.js):

1. `REMINTABLE_REASONS`: consumers named (the consent-op gate
   `consentOpFreshAuthRetryGate` serving both orchestrators, the
   session-kind retry in `broadcastWithFreshAuth`, and the upload retry in
   `uploadFile`, lib/ipfs-upload.js); numeral removed.
2. `handleSessionInconsistency`: caller surfaces named
   (`broadcastWithFreshAuth` both legs, `consentOpFreshAuthRetryGate`,
   `tornDownSession` in lib/ipfs-upload.js); the parenthetical now carries
   all three shapes including the upload throw (`UPLOAD_SESSION_TORN_DOWN`).
3. "the eight broadcast call sites" is now "every broadcast call site". The
   permissive census in `broadcastWithFreshAuth`'s docblock is now the
   complement form ("every other call site keeps the permissive default");
   the suppressed enumeration (publish + edit submit sequences) re-verified
   exact against the tree and kept.
4. `cacheSessionProof`'s universal scoped to "the module's other explicit
   corruption checks"; the consent-op reader's parse catch is outside the
   stated class and its behavior untouched.
5. Item-5 sweep findings, fixed in the same commit: the recurrence example
   ("the next vote, comment and review" is now "each broadcast action that
   follows"); the stale "call-site discriminators (publish.js,
   vote-buttons.js, vouch-section.js)" parenthetical (no call site inspects
   the rejection shape today; now subjunctive); and the per-surface
   wire-shape claims in the `isUsernameMismatch` and
   `consentOpFreshAuthRetryGate` docblocks. Those two claimed all
   consent-op/settings/upload errors are status-less api.js
   ApiRequestErrors, but the authorship orchestrator's guarded call is
   signer.js `broadcastOps` (pages/paper-detail.js `_broadcastConsentOp`)
   whose errors carry `status` (403 on a mismatch); only settings and
   upload raise the status-less shape. Verified directly at the
   paper-detail run callback, the signer.js error shaping, and the api.js
   ApiRequestError constructor.

Verification: five-agent adversarial census workflow (one independent
census per population plus a cross-refuter), all clean, converging on the
same censuses (three retry gates; five mismatch-teardown call sites on
three surfaces; nine broadcast call sites split three suppressed / six
permissive; corruption checks all drop with the parse catch outside the
class). Frontend unit suite 86 files / 1944 tests green, exit 0, count
unchanged before and after; `npm run build` clean; `.githooks/pre-commit`
anchor gate passed on the staged diff.

Out-of-scope observations for architect triage (not fixed):

- tests/unit/fresh-auth-401-retry.test.js carries the same permissive
  census drift in a test comment ("vote/comment/review call sites pass no
  option"; vouch-section's two sites also pass none). Task scope says no
  test changes.
- `toastLocalized`'s docblock locates its third call site "in the
  password-factor mint", but the call lives in `subjectTeardownGuard`'s
  cancel closure, which fires from teardown cancels across several flows,
  not only the mint. toastLocalized call sites are outside this task's
  four populations.

## Architect re-review (2026-09-29) — HELD PENDING FIXES:

Round 1 review of commit 5cb292ba: every rewritten claim verified true
against the tree (censuses re-derived independently and converging with the
signal block), standards and conventions clean, all universals survived
adversarial falsification. Held on one validated in-file miss plus the two
out-of-scope observations above, which the user routed back onto this task.
All three are comment-only rewording; the Scope section's "no test changes"
line is lifted for item 2 only.

1. `evictUnnamedAcquisition` docblock: "to be re-read and re-refused on
   every later vote, comment and review until the entry's idle deadline
   arrived" still enumerates the triple as if it were the census; the vouch,
   retract-vouch, publish and edit broadcasts re-read the same stranded slot
   (six of the nine call sites are not vote/comment/review). Reword to the
   quantified form this commit adopted for the identical phrase in
   `acquisitionAborted`'s docblock, e.g. "on every later broadcast action".
   Acceptance criterion 1 covers this sentence; the item-5 sweep missed it.

2. tests/unit/fresh-auth-401-retry.test.js: the test comment
   "vote/comment/review call sites pass no option" carries the same
   permissive-census drift (vouch-section's two sites also pass none).
   Reword so the sentence does not read as a closed member list: quantify
   ("the call sites outside the publish and edit submit sequences pass no
   option") or name all six. Comment-only; suite count must not change.

3. `toastLocalized` docblock: locate the third call site by the symbol that
   owns it — `subjectTeardownGuard`'s cancel closure — rather than "in the
   password-factor mint", which names only one of the flows that reach it.

Acceptance criteria 3-4 apply unchanged to all three items (no rot-class
anchors in replacement text; `.githooks/pre-commit` passes; suite count
byte-identical; `npm run build` clean). When landed, `git mv` this file
back to tasks/review/ per rule #8.

## UI re-review signal (2026-09-29, commit c12eab4f)

All three hold items landed in c12eab4f (comment-only):

1. `evictUnnamedAcquisition` docblock: "every later vote, comment and
   review" is now "every later broadcast action".
2. tests/unit/fresh-auth-401-retry.test.js permissive-default control: "the
   call sites outside the publish and edit submit sequences pass no option".
   Same-class sweep of the test file found one more instance, which is fixed
   in the same commit: the mint-leg recurrence comment ("prompts for the
   password on every vote, comment and review") is now "on every broadcast
   action". This goes one sentence past the item-2 scope lift. It is the
   same drift in the same file, so revert it if you want that lift to stay
   strict.
3. `toastLocalized` docblock: the third caller is located as "the cancel
   closure of `subjectTeardownGuard`".

Verification: an adversarial census workflow with four lenses (broadcast
call sites, toastLocalized and subjectTeardownGuard callers, the
REMINTABLE_REASONS, handleSessionInconsistency and corrupt-entry
populations, and a diff audit) plus refuters found no disagreement in either
file. Censuses: nine broadcast call sites, three suppressed and six
permissive; three toastLocalized callers; three retry gates; five
mismatch-teardown call sites on three surfaces. Its one note was a
111-column overlong wrap in the rewritten test comment, rewrapped before the
commit. Frontend unit suite: 86 files, 1955 tests, exit 0. The count grew
from the round-1 figure of 1944 because of sibling commits in between; this
diff is comment-only. `npm run build` is clean, and the `.githooks/pre-commit`
anchor gate passed on the commit.

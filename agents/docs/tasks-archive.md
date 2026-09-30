## The outcome tally's source sentence still binds three sites to the raw result (archived 2026-09-30)

Architect note (2026-09-30): retired as superseded, no implementation under this task.
Commit a9150a6f (the fresh-auth clear-and-site-counts task) landed exactly this scope:
the `WINDOW_OUTCOME_BY_SENTINEL` header now says `acquisitionAborted` reads the raw
result while `freshAuthWindowReady` and `windowProof` act on the outcome object
`ensureSessionWindow` derives, and the reconciling clause in `evictUnnamedAcquisition`'s
docblock is gone. Verified at HEAD against all three acceptance criteria: no sentence
binds the page gate or the upload pre-flight to the raw result; no cross-docblock
assertion survives (the TWO-site sentence names its own members); a9150a6f is
comment-only (47 of 47 changed lines are `//` lines) and passed /ce-code-review on those
sentences the same day. The one item that review held concerns a different count (the
gated-clear sentences) and stays with the clear-and-site-counts task.


**Owner:** ui
**Created:** 2026-09-09

Routed out of the re-review of the broadcast-path window eviction task, which
corrected the reading site but not the sentence that seeded the miscount. Raised
independently by two review lenses and confirmed at validation.

## Why

`evictUnnamedAcquisition`'s docblock now correctly says TWO sites read the raw
acquisition result: the fail-closed guard in `ensureSessionWindow` and the
broadcast unwinder `acquisitionAborted`. To reconcile that against the THREE-site
tally in `WINDOW_OUTCOME_BY_SENTINEL`'s docblock, it added a clause asserting that
the other tally "tallies who acts on an outcome ... not who reads the raw result".

That sentence does not say what the clause says it says. It reads that
`acquireSessionProof` "resolves to a proof string or to one of the sentinels
below, and three independently owned sites consume the result", then names
`freshAuthWindowReady`, `acquisitionAborted` and `windowProof`. The definite
article binds all three to `acquireSessionProof`'s result, and two of the three
provably never see it: `freshAuthWindowReady` and `windowProof`
(`lib/ipfs-upload.js`) both consume `ensureSessionWindow`'s derived outcome
object. Only `acquisitionAborted` is a member of both tallies.

So the module reconciles a real imprecision from a distance, by asserting a
reading of a sentence rather than amending it. The next reader who checks the
claim against the sentence finds they disagree, which is the same rot the
corrected count was fixing. The correct phrasing already exists in the module's
own dispatch suite header.

## Scope

1. Amend `WINDOW_OUTCOME_BY_SENTINEL`'s docblock so its tally binds to the outcome
   vocabulary rather than to `acquireSessionProof`'s result, and so it says which
   of the three named sites read the raw result and which read the derived
   outcome. Naming the members inline is preferred over restating a count.
2. With the source sentence precise, shrink or drop the reconciling clause in
   `evictUnnamedAcquisition`'s docblock. Two hand-maintained tallies in one file
   that need a third sentence to stay consistent is the shape to remove, not to
   document better.
3. Out of scope: the two counts themselves are both correct as numbers, and
   `acquireSessionProof`'s eviction behaviour is settled. This is a prose accuracy
   task, not a behaviour change. No production logic may change.

## Acceptance criteria

1. No sentence in `lib/fresh-auth.js` binds `freshAuthWindowReady` or `windowProof`
   to `acquireSessionProof`'s raw result.
2. Any surviving cross-reference between the two docblocks is checkable against
   the text it points at, not an assertion about what that text means.
3. Suite green, build clean. No production logic changed: the diff is comments
   only, confirmed by reading it.

## Notes

The sibling work this was going to be sequenced behind has already landed
(f9b6ad8d, the broadcast path's unnamed refusal). It rewrote the closing paragraph
of the `ensureSessionWindow` guard docblock and added the `?? 'failed'`
fall-through in `acquisitionAborted`, but touched neither sentence this task is
about: both were confirmed present and unchanged at that commit. So there is no
sequencing constraint left. Re-read both docblocks from the committed tree anyway
before starting, since that file is edited often.

Nothing mechanically pins either tally. A third raw-result reader added later
inherits the producer eviction automatically, so the exposure is documentation
drift rather than a lockout regression, which is why this is prose-only and
carries no canary.

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

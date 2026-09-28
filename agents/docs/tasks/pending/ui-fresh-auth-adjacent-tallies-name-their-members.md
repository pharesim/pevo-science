# Four more fresh-auth docblock tallies disagree with the tree

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

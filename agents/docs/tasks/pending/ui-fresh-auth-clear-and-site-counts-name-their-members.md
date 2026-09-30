# Two fresh-auth docblock counts disagree with the file they sit in

**Owner:** ui
**Created:** 2026-09-22

Routed out of the round-5 archive of the fresh-auth dispatch task. Neither
site was touched by that task's diff, so neither held it; both are the class
`agents/docs/solutions/conventions/sibling-docblock-tallies-must-each-state-precisely-what-they-count-2026-09-09.md`
documents, and that entry names the second one as its own still-open repair.

## Why

Two count claims in `frontend/src/lib/fresh-auth.js` are false or misleading
read alone, and each has a neighbour in the same file that states the true
count, so a reader landing on either gets a different answer depending on
which paragraph they read first.

1. **"the sibling clears in `broadcastWithFreshAuth`" (plural), twice.** One
   site is the docblock above `clearCachedSessionProof`'s tokenless/TTL
   companions ("the successor-pays-a-re-auth harm that gates the sibling
   clears in `broadcastWithFreshAuth`"); the other is
   `evictUnnamedAcquisition`'s docblock ("Ungated, unlike the sibling clears
   in `broadcastWithFreshAuth`. Those hold a real round-trip..."). That
   function holds exactly one `clearCachedSessionProof()`, the remintable-401
   eviction behind `if (!guard.tornDown())`, and `ensureSessionWindow`'s guard
   docblock in the same file already says so: "the module's one GATED clear,
   the 401 eviction in `broadcastWithFreshAuth`". Three sentences, two counts.

2. **"three independently owned sites consume the result" at
   `WINDOW_OUTCOME_BY_SENTINEL`.** The sentence names `freshAuthWindowReady`,
   `acquisitionAborted` and `windowProof` as consumers of what
   `acquireSessionProof` resolves. Only `acquisitionAborted` reads the raw
   result; the other two read the outcome object `ensureSessionWindow` derives
   from it. `evictUnnamedAcquisition`'s docblock currently reconciles this from
   a distance ("The THREE-site tally at `WINDOW_OUTCOME_BY_SENTINEL` is a
   different and equally correct count: it tallies who acts on an outcome...
   not who reads the raw result"), which the sibling-tallies learning ruled is
   an explanation of the discrepancy rather than its removal.

## Scope

Comment-only. No executable line changes, no test changes, suite count
byte-identical before and after.

1. Replace both "sibling clears" sentences with wording that names the one
   gated clear (the remintable-401 eviction in `broadcastWithFreshAuth`) and
   states, in each sentence's own words, why the clear it is describing does
   not share that gate's reason. Prefer naming the member over restating a
   number, per the learning's "A, B and C do X cannot drift the way three
   sites do X can".
2. Edit the `WINDOW_OUTCOME_BY_SENTINEL` sentence directly so it is correct
   read alone: `acquireSessionProof` resolves to a proof string or a sentinel;
   `acquisitionAborted` reads that raw result; `freshAuthWindowReady` and
   `windowProof` act on the outcome object `ensureSessionWindow` derives from
   it. Then shrink or drop the reconciling clause in `evictUnnamedAcquisition`'s
   docblock, since a precise target sentence leaves nothing to reconcile.
3. Before landing, sweep the file for any OTHER sentence that counts the same
   populations (clears in this module; consumers of the acquisition result or
   the outcome object) and check each one semantically, not by phrase: the
   learning records that a phrase-matched sweep missed the sentence in item 2
   the first time.

## Acceptance criteria

1. Every sentence in `fresh-auth.js` that counts clears, or counts consumers
   of the acquisition result, agrees with the code and with every other such
   sentence in the file, read in isolation.
2. No reconciling clause remains that explains a discrepancy instead of
   removing it.
3. The replacement text carries no line numbers, SHAs, task slugs, round
   ordinals, or bare positional anchors; `.githooks/pre-commit` passes on the
   staged diff.
4. Full frontend unit suite green with an unchanged count; `npm run build`
   clean.

## Notes

Dismissed at the same triage, do not reopen: the spec title `the refusal
evicts the entry that caused it` in `lib-fresh-auth-session-window.test.js`
credits the refusal with an eviction that either clear satisfies; it is
defensible as written because the refusal path does end with the entry gone.

## UI implementation signal (2026-09-28, commit a9150a6f)

All work landed in commit a9150a6f (`ui(fresh-auth): docblock count tallies
name their members`), verified an ancestor of main before this move.

- Scope item 1: both "sibling clears" sentences (at `getCachedConsentOpProof`
  and `evictUnnamedAcquisition`) now name the module's one gated clear, the
  401 eviction in `broadcastWithFreshAuth`, and each states in its own words
  why the clear it describes carries no gate (adjacent synchronous
  statements vs. a real broadcast round-trip inside the gated one).
- Scope item 2: the `WINDOW_OUTCOME_BY_SENTINEL` header now states the split
  directly (`acquisitionAborted` reads the raw result; `freshAuthWindowReady`
  and `windowProof` act on the derived outcome object), and the THREE-site
  reconciling clause in `evictUnnamedAcquisition`'s docblock is dropped.
- Scope item 3 (semantic sweep): ran as a 6-agent adversarial workflow (two
  population sweeps, one reconcile-hunt, three cold-read refuters) plus a
  follow-up refuter on revised text. It surfaced two more in-population
  sentences, both fixed in the same commit: the header's resolution-set
  totality overclaim (unnamed values now named, matching
  `acquireSessionProof`'s own docblock) and `showWindowOutcomeToast`'s
  "every site that consumes an acquisition outcome" universal (callers now
  enumerated: `freshAuthWindowReady`, `acquisitionAborted`, `promptBusy`;
  `windowProof`'s separate upload-error-code channel stated).
- AC 3: `.githooks/pre-commit` anchor gate passed on the staged diff
  (standalone run and at commit time). AC 4: `npx vitest run` green, 86
  files / 1938 tests (count unchanged across pre- and post-edit runs);
  `npm run build` clean.

Out-of-population count claims the sweep surfaced, left untouched for
architect triage (they count populations outside this task's scope):

1. `REMINTABLE_REASONS` docblock says "the three retry gates" but a fourth
   gate consumes it: the upload surface's retry in `lib/ipfs-upload.js`.
2. `handleSessionInconsistency` docblock says "all three fresh-auth
   orchestrators", but the upload surface's torn-down handler in
   `lib/ipfs-upload.js` is a fourth caller, with a thrown upload code as a
   third sentinel shape its parenthetical omits.
3. `acquisitionAborted` docblock says "the eight broadcast call sites"; the
   tree has nine call expressions (both `vote-buttons.js` branches, two in
   `vouch-section.js`, two in `edit.js`, plus publish/review/comment).
4. `cacheSessionProof`'s "matching every other corrupt-entry case in this
   module: drop the slot" has a defensible counterexample: the consent-op
   reader's parse-catch swallows an unparseable entry without removing it.

## Architect re-review (2026-09-30) — HELD PENDING FIXES:

Reviewed commit a9150a6f against a9150a6f and against main (the added
sentences are unchanged on main). Comment-only claim, AC 2 and AC 3 hold; the
consumer enumerations (scope item 2 and the `showWindowOutcomeToast` callers)
are complete. One item holds AC 1.

1. **"the module's one gated clear" is a module-wide count that the module
   does not support.** The phrase now stands three times in
   `frontend/src/lib/fresh-auth.js`: in `getCachedConsentOpProof`'s docblock,
   in `evictUnnamedAcquisition`'s docblock (both written by a9150a6f), and in
   the fail-closed guard comment inside `ensureSessionWindow` (older, and the
   sentence this task's "Why" quoted as the true count, so the prescription
   carried the overreach; that is on the task text, not the implementation).
   The count is true only of `clearCachedSessionProof()` calls, that is, of
   the session-window slot. Module-wide there is a second teardown-gated
   removal: `unwindFlowKeys` in `beginOrcidFreshAuthRedirect` returns early on
   the stale predicate (the same `guard.tornDown` signal) before removing
   `ORCID_MODE_KEY` and calling `clearReturnPath()`, for the same
   protect-the-successor reason. The file does not reserve "clear" for the
   window slot either: the `getCachedConsentOpProof` sentence says "the slot
   it clears" of the consent-op slot in the same paragraph, so a reader there
   has nothing that scopes the count.

   Fix, comment-only: scope all three sentences to what they count, the
   session-window slot (for example "the one gated clear of the session-window
   slot, the 401 eviction in `broadcastWithFreshAuth`"). Keep the count scoped
   to this module's calls in whatever wording lands: `uploadFile` in
   `lib/ipfs-upload.js` holds its own `if (!guard.tornDown())
   clearCachedSessionProof()`, so a slot-wide claim with no module qualifier
   would be false against that site. Then re-run scope item 3's semantic sweep
   for any other sentence counting gated or ungated removals.

Already resolved elsewhere, no action here: the four out-of-population count
claims listed at the end of the implementation signal were repaired on main by
the adjacent-tallies task (archived 2026-09-30).

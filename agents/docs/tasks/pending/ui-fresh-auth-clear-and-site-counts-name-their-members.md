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

## UI re-review signal (2026-09-30, commit 590d211a)

Landed in 590d211a (`ui(fresh-auth): the gated-clear sentences name the clear
instead of counting it`), verified an ancestor of main before this move.
Comment-only; `npx vitest run` exit 0 at 87 files / 1980 tests before and
after; `npm run build` clean; the pre-commit anchor gate passed at commit time.

- Hold item 1: all three sentences (`getCachedConsentOpProof`'s docblock,
  `evictUnnamedAcquisition`'s docblock, the fail-closed guard comment in
  `ensureSessionWindow`) are scoped to the session-window slot and to
  `broadcastWithFreshAuth`. **Deviation from the example wording, for
  architect judgement:** they carry no count at all. The sweep's cold read
  and its refuter both found the slot-scoped "one" contestable on the same
  reading that sank the module-wide one: `cacheSessionProof`'s fail-closed
  `dropWindow()` is reached in this module only past the mint callback's
  `guard.tornDown()` early return, and the guarded `slideSessionWindow()` in
  `attemptOnce` can drop an expired window through `readSessionWindow`. So
  each sentence names the member ("the teardown-gated dead-window clear of
  the session-window slot in `broadcastWithFreshAuth`") and says nothing
  about how many there are, which also stays true against `uploadFile`'s
  own gated clear.
- The same sentences dropped "401 eviction": that clear runs under every
  `FRESH_AUTH_REQUIRED`, ahead of the `status === 401` test, so it also runs
  on the 403 binding violations. "Dead-window clear" is the name the
  `attemptOnce` comment and `lib/ipfs-upload.js` already use.
- Sweep re-run (13-agent read-only workflow: code-only removal inventory,
  three chunk sweeps, a cold read of the new sentences, one refuter per
  finding). Two further removal totals confirmed and fixed in the same
  commit: `getCachedConsentOpProof`'s "nothing else would drop the entry
  inside its TTL" (the subject scrub does) and the `unwindFlowKeys` comment's
  "every other exit removes them" (the navigating exit keeps the keys).
- Refuted by the sweep, left as written: "Only a rejection of the password
  retires it" in the password-mint comment (scoped by its own second
  clause), "both writers of that slot" in `evictUnnamedAcquisition`'s
  docblock (`persistWindow` has exactly two callers), and "both now inherit
  the one eviction" in the `ensureSessionWindow` guard comment (the guard's
  own clear is called a restatement in the same block).

## Architect re-review (2026-09-30, second pass) — HELD PENDING FIXES:

Reviewed commit 590d211a against its parent. Comment-only confirmed (the
comment-stripped file is byte-identical across the commit), the anchor gate
has no hit on the added lines, the build is clean, and the suite count matches
the signal at 87 files / 1980 tests.

Hold item 1 of the previous block is met. The three rewritten sentences are
true against the code, and the deviation from the example wording is accepted
on both points: a sentence that names the clear and carries no count is the
better repair, and "401 eviction" was wrong for the reason the signal gives
(the clear runs on every `FRESH_AUTH_REQUIRED`, ahead of the status test). The
three-way `unwindFlowKeys` sentence is accurate for every exit past the start
round-trip. Two items hold AC 1.

1. **"short of a subject scrub nothing else would drop the entry inside its
   TTL" is still a false total.** It closes the paragraph in
   `getCachedConsentOpProof`'s docblock that opens "A token that is not a
   string is corruption", and 590d211a wrote it. The consent-op slot is one
   unkeyed `CONSENT_OP_PROOF_KEY` entry, and three paths other than the
   subject scrub remove or replace whatever it holds, whichever target the
   entry was minted for:
   - `clearCachedConsentOpProof()` after `run(proof)` resolves, in
     `withSettingsFreshAuth` (`lib/settings-fresh-auth.js`) and in
     `withAuthorshipFreshAuth` (`lib/authorship-consent.js`). It takes no
     target, so a successful action on any target empties the slot.
   - `consentOpFreshAuthRetryGate`'s `clearProofCache()`, which runs on any
     action's `FRESH_AUTH_REQUIRED`.
   - the `cacheConsentOpProof` write in the `/orcid/callback` fresh-auth
     handler, which overwrites the slot.

   One path that shows it: a non-string token sits cached for one admin
   authority action; the user runs a different one; the lookup misses on the
   action and returns null without removing; a proof is minted; the run
   succeeds; the success clear empties the slot inside the entry's TTL, and no
   subject scrub ran.

   Fix, comment-only: drop the total and say only what the paragraph needs,
   which is that nothing on the refused action's own path retires the entry.
   Do not repair it by naming more exceptions; the previous round added one
   member to the universal instead of re-deriving the set, and that is how the
   sentence stayed false. A shape, to be checked against the code before use
   and not copied on trust: "On those the gate's clear never runs, so inside
   its TTL nothing on that action's own path would drop the entry: each retry
   of it would re-read the entry and draw the same validation rejection."

   Same paragraph, same edit: the sentence before it, "The entry cannot
   outlive that refusal by way of the retry gate either", reads as the
   opposite of what its own explanation shows. The gate rethrows before it
   reaches `clearProofCache`, so the gate does not retire the entry and the
   entry does outlive the refusal. It predates 590d211a and is not charged to
   that commit; it is folded in here because it is the premise of the sentence
   this item rewrites. State it the right way round.

2. **"Only a rejection of the password retires it" carries no scope of its
   own.** It is in `mintViaPasswordFactor`'s docblock. The subject scrub
   (`_scrubSubjectBoundState` in `auth.js`) also calls
   `clearPasswordFactorMemo()`, with no mint attempted and no password
   rejected, and the memo's own docblock in the same file says "the two
   erasers (the subject scrub and the mint route's second consecutive
   rejection)". The signal judged the sentence scoped by its second clause.
   Two of the four review lenses read it that way too; the validation pass did
   not, because "on the retry mint" sits in the clause after the semicolon and
   modifies only the transport failure. Read alone, the first clause gives one
   eraser where the memo docblock gives two.

   Fix, comment-only: put the scope in the clause that makes the claim, for
   example "On the retry mint, only a rejection of the password retires it; a
   transport failure there leaves the memo standing."

For the sweep that accompanies these: where a kept sentence says only, nothing
else, every or no other about what removes an entry, derive the remover set
from the slot (every caller of its clear function, plus every write that
replaces it), not from the path the surrounding paragraph is discussing. The
last sweep checked each sentence against its own paragraph: it gave item 1's
sentence one more member and judged item 2's correct as written.

Dismissed at this triage, do not reopen:

- "both now inherit the one eviction rather than each owning its own" in the
  `ensureSessionWindow` guard comment. Raised by three lenses and rejected at
  validation. Every value that guard refuses has already been through the drop
  in `evictUnnamedAcquisition`, so the guard's own `clearCachedSessionProof()`
  restates a drop that has already run, and `acquisitionAborted` carries no
  clear.
- "every other failing exit removes them" against a throw from the
  `ORCID_MODE_KEY` write: that write sits ahead of the start round-trip, and
  the comment scopes itself to exits past it.
- "A miss (window already closed) is a no-op" in `slideSessionWindow`'s
  docblock: it describes the slide, which writes nothing on a miss.
- The "a no-op when the password factor was used" parentheticals beside the
  success clears in `lib/settings-fresh-auth.js` and
  `lib/authorship-consent.js`: other files, outside this task.
- The one 84-column line the reflow left in the `ensureSessionWindow` guard
  comment: style only, not held. Rewrap it if an edit takes you into that
  paragraph.

Open, not part of this hold: "every teardown boundary a flight crosses
resolves FRESH_AUTH_CANCELLED" (`evictUnnamedAcquisition`'s docblock, restated
in the `ensureSessionWindow` guard comment) is not universal, since a stale
ORCID start that rejects propagates the rejection, as
`beginOrcidFreshAuthRedirect`'s docblock says. It counts neither clears nor
consumers, so it is outside this task's population, and where it lands is
awaiting a triage decision. Leave both sentences as they are under this hold.

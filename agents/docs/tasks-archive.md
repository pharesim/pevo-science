## Decide whether a second concurrent session-inconsistency detection should speak (archived 2026-10-05) — clean review at 790eee0e; silent-sign-out message accepted; implementer's successor-teardown item already filed

### Architect archive note (2026-10-05)

Review of 790eee0e with /ce-code-review (full: correctness, project-standards,
testing, adversarial in-process, julik-frontend-races, learnings). Reviewers read
git-show snapshots at 790eee0e, because five later sibling commits (590d211a,
b3d52627, 7247ff5b, 8594733d, b9de6dcc) had reshaped fresh-auth.js, moving the handler
body into tearDownSessionWithMessage. No finding at the reporting threshold. All four
ACs met. Full unit suite at 790eee0e re-run in an isolated copy: 87 files, 1980 tests,
exit 0. Mutation probes in isolated copies: dropping the isConnected gate fails 3 pins;
a bare return in the disconnected branch fails the silent-sign-out pin; claiming
before disconnect fails 4 tests. The project-standards pass was shallow (it did not
open the cited convention docs).

Triage (user approved as recommended):
- Accepted, no change: a mismatch after a silent sign-out shows the session-changed
  message instead of the re-login message (unrequested behavior rule; reasoned in the
  docblock and pinned).
- Folded into `ui-fresh-auth-and-upload-comments-that-overclaim` (item 4, new bullet):
  the `UPLOAD_SESSION_TORN_DOWN` comment in lib/ipfs-upload.js names only the re-login
  toast (correctness + adversarial, still present at HEAD). The matching
  broadcastWithFreshAuth "runs the same scrub again" sentence was already gone at HEAD.
- Implementer's "For architect triage" item (mismatch arms do not consult their
  teardown guard, so a session established mid-flight is torn down): already filed as
  `ui-upload-mismatch-teardown-after-subject-change`, which covers the upload leg and
  asks for a check of the broadcast and consent-op arms. Not worsened by this diff
  (adversarial S3 probe).
- Dismissed: no upload-plus-broadcast cross-surface pin (same handler, probe correct
  today); AC3 fixture flips unobserved in the settings and authorship suites; the gate's
  dependency on disconnect() being the sole isConnected=false writer (holds at HEAD).
- Deferred: /ce-compound-refresh of
  solutions/conventions/guard-report-dedupes-per-event-not-per-holder-2026-09-02.md,
  whose code sample predates the liveness gate and reportTeardownOnce. Run it after
  `ui-session-invalidated-global-handling` is reviewed, since that task reshaped the
  same handler.

### Task file

**Owner:** ui
**Created:** 2026-09-02

Routed out of the architect round-3 review of `ui-consent-op-teardown-guard`
(`69686a16`). Not held there: three reviewers raised it independently and the adversarial
pass reproduced it, but the validator established the behaviour as pre-existing and
unaffected by that commit, and the obvious fix carries a behaviour decision the round-3
hold should not absorb.

## Why

`handleSessionInconsistency()` in `lib/fresh-auth.js` disconnects the auth store, claims
the teardown report, and toasts. The disconnect and the claim now sit inside an
`if (auth)` branch, so the claim is only stamped when there was a real teardown to claim,
but nothing gates the sequence against a SECOND caller detecting the same fault. It is
called from five sites across three modules (the broadcast surface's first-attempt and retry mismatch arms,
the consent-op retry gate, and the upload surface's mismatch teardown).

Two concurrent flights that each detect the same corrupted session therefore each run the
whole sequence, and the user sees two identical "Session inconsistency detected. Please
sign in again." messages for one incident. Reproduced by driving two mismatch legs
concurrently: two toasts, where the surrounding work's stated contract is exactly one
message per teardown.

The reachable shape is the publish page, where an inline-image upload and the submit
broadcast can be in flight together against the same divergent JWT-and-proof pair.

## The decision this task exists to make

The `_reportedTeardownGeneration` claim cannot solve this, and reaching for it is the
trap: each call's `disconnect()` re-runs the subject scrub and bumps the generation, so
the second detector legitimately observes a new generation. Under the dedup mechanism's
own semantics, two detectors are two teardowns, not one teardown reported twice.

So the question is not "how do we dedup this" but "should a second, genuinely new teardown
speak at all". Suppressing it also suppresses a real second event; keeping it means the
one-message contract holds per teardown but not per incident.

The proposal to evaluate, not to apply unexamined: gate on the store's own liveness before
disconnecting, so a second caller short-circuits once the first has torn down.

```js
const auth = Alpine.store('auth');
if (auth) {
  if (!auth.isConnected) return;
  auth.disconnect();
  claimTeardownReport();
}
toastLocalized(/* ... */);
```

Note the shape: the liveness short-circuit and the claim both belong INSIDE the `if (auth)`
branch. An earlier draft of this proposal was written against a version of the function
whose claim ran unconditionally; applied literally on top of the current code it would move
`claimTeardownReport()` back outside the branch and re-introduce the stamping-with-no-
teardown defect that branch exists to prevent.

Whichever way it goes, the outcome must be written down where the next reader meets it:
either the function's docblock states that repeat detections are deliberately silent, or
it states that each detection speaks and why that is the right trade.

## Acceptance criteria

1. A decision is recorded in the code, not only in this file: `handleSessionInconsistency`
   carries a docblock sentence stating whether a repeat detection speaks, and why.
2. Two concurrent flights that each detect `username_mismatch` against the same corrupted
   session produce the message count that decision calls for, pinned by a test that fails
   if the behaviour flips.
3. If the early return is adopted, the store fixtures that stub `disconnect` as a bare
   `vi.fn()` (they never flip `isConnected`) are updated so the suites exercise the
   production shape rather than passing because the flag never moves.
4. No surface loses its teardown message entirely: a single detection still reports, and
   the existing "exactly one" assertions across the fresh-auth and upload suites stay green.

## Notes

Related but distinct from the report-collapse mechanism already in `fresh-auth.js`: that
one dedups several flights abandoned by ONE scrub, and works. This is about several scrubs
raised by several detectors of one underlying fault. Do not widen the existing claim to
cover this case without first settling the question above.

UI implementation signal (2026-09-30, commit `790eee0e`):

**Decision: a repeat detection is quiet.** Only the detector that finds the store
still connected disconnects and shows the re-login message. Recorded in the
`handleSessionInconsistency` docblock (AC1).

The proposal's bare `return` was amended. A detector that finds the store already
disconnected calls `reportTeardownOnce()` (the claim-keyed report extracted from
the guard's `cancel`) and then returns. After a sibling detector that is silent,
because the first detector claimed the generation. After a sign-out that showed
nothing (this tab's, or another tab's over the storage event) it shows the
session-changed message once. Reason: with a bare return that second sequence
ends with no message at all, since every caller shape is silent at the page
layer, which AC4 rules out. The liveness check and the claim both stay inside the
`if (auth)` branch.

- AC2: `fresh-auth-401-retry.test.js` "two flights detecting the same corrupted
  session tear down and report once" (one disconnect, one toast). Observed red
  before the change (2 and 2). A second pin covers the upload leg through the
  real window and the real `tornDownSession`
  (`lib-ipfs-upload-real-window.test.js`), and a third covers the mismatch that
  lands after a silent sign-out.
- AC3: the three suites that run the real handler on a mismatch
  (`fresh-auth-401-retry`, `lib-settings-fresh-auth`, `lib-authorship-consent`)
  now carry `isConnected` and a disconnect that flips it. The consent-op suites
  returned a fresh store literal per read; they now return one object. Suites
  that never drive a mismatch into the real handler were left alone.
- AC4: full unit suite green, 87 files, 1980 tests, exit 0. No Playwright run
  (no e2e spec induces `username_mismatch`).

**For architect triage, not fixed here (pre-existing, out of this task's scope):**
none of the five mismatch arms consults its teardown guard before calling
`handleSessionInconsistency`. If a login lands before the mismatch response
(another tab signs in as someone else, or a re-login inside the round trip),
the store reads connected again and the handler disconnects the successor's
healthy session with the re-login message. The liveness gate neither causes nor
cures this, and the docblock says so. Closing it means threading the guard into
the arms, which changes what the primary single-flight mismatch does, so it is a
decision rather than a fix.

## Close the last two retired-model sentences in fresh-auth, and pin the retirement contract (archived 2026-10-05) — clean review at b80ebff1; probes m1-m3 reproduced; two AC1 wording calls dismissed

### Architect archive note (2026-10-05)

Review of 6dd794d3 and b80ebff1 with /ce-code-review (full: correctness,
project-standards, testing, adversarial in-process, learnings). Reviewers read
git-show snapshots at b80ebff1, because sibling commit 83e3ce9a (the tier-prose task)
and an uncommitted sibling edit had moved fresh-auth.ts after the reviewed commits.
Zero findings at any severity. Suites at b80ebff1: 109 / 5 / 4, exit 0, nothing
skipped. All three signal-block probes reproduced in isolated copies, each prober on
its own Redis DB index: m1 fails the new ledger test, the redis-unavailable-burn ledger
test and two offline-queue tests; m2 fails only the new retained-direction assertion;
m3 fails the new ledger test and both new delSpy not-called assertions. The item 3
deviation is accepted: the redis-unavailable-burn suite already pinned the release
direction. Typecheck and lint were not re-run (implementer's claim).

Two AC1 wording calls, dismissed by the user at triage. The "stays for the drain"
clauses in the inFlightConsumes docblock and in burnConsentOpEntry's alreadySpent
comment name the drain without the later-replay exit, but each already names a resolved
GETDEL as an exit and the drain is the only guaranteed one. "Redis-issuance success" in
the test-file header bullet and two test titles names the scenario precondition, not a
conditional backup. The signal block's four out-of-scope statements were filed as the
tier-prose task, now in review. No /ce-compound.

### Task file

**Owner:** backend
**Created:** 2026-09-02

Routed out of the architect review that archived the consent-op burn task. That task's
six review passes were all one failure class: a sentence stating a model the code no
longer implements, left standing by a rewrite that touched the lines around it. Two
such sentences remain, and the release event the last round newly documented is
asserted nowhere. Filed separately rather than held, because the parent's three items
were confirmed closed and a seventh round on one comment is not worth reopening a
1477-line task file.

## Why

The reviewed state is `b8b4277d`. Items 1 and 2 are prose defects in
`backend/src/lib/fresh-auth.ts`; items 3 and 4 are test pins in
`backend/tests/lib/fresh-auth.test.ts`.

## Scope

### 1. The session issuance backup comment states a conditional model its own code contradicts

`issueSessionFreshAuthToken`'s comment above the `memStore.set(...)` call says the
write happens "whenever Redis-issuance succeeds", and defends itself as "NOT dead code
in the Redis-success branch". Both are false about the lines beneath them: the write is
unconditional and runs before `getRedis()` is called at all, so no Redis-success branch
contains it.

It matters beyond tidiness because the sentence names `issueFreshAuthToken` as its
referent ("same recovery rationale as"), and the consent-op sibling's matching comment
was rewritten to the opposite, unconditional model. The cross-reference now resolves to
text stating the opposite of what it claims to share. The question it misleads on,
which tier can hold a presentable proof during a flap, is the reasoning the whole ledger
design rests on.

Fix: adopt the wording already used at the consent-op site, and drop the dead-code
clause, which presupposes a branch the write does not sit in.

### 2. The drain docblock's "one event" survives item 2 of the parent's round-6 hold

The `drainSpentConsentOps` docblock still says the `DEL` resolving is "the one event
that proves the canonical key unreadable". That sentence was deliberately not held in
the parent's round 6, on the reasoning that its "its delete" scoping kept it defensible
and that it would become the last over-readable statement in the file once the burn
docblock adopted the two-event form. The burn docblock has adopted it. A wrap-tolerant
sweep over both files now returns this as the only remaining hit.

Fix: bring it into the same two-event form `burnConsentOpEntry` and `spentConsentOps`
already use, scoped so it stays true of the drain specifically.

### 3. The second release event has no test

The burn's retirement contract has exactly two release events. The one the last round
newly documented, the `alreadySpent` branch retiring an entry on its own resolved
`GETDEL`, is asserted by nothing. The contract is agreed between prose and code only by
inspection, which is precisely how the parent's item 2 drifted with no failing test to
catch it.

The hooks already exist: `_setSpentConsentOpForTests` and
`_getSpentConsentOpsSizeForTests` are exported. Plant a ledger entry for a token whose
Redis key is still live, consume it, then assert the consume is refused, the ledger is
empty, and the canonical key is gone.

Pin the retained direction too: an entry must SURVIVE a presentation whose own `GETDEL`
rejects, since `redisLegRan` is false there and the guard must stay standing.

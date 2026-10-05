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

### 4. Neither split-tier test pins that the tiers actually split

Both split-tier race tests install a `redis.del` spy, restore it, and never assert on
it. The compensating delete is issued only on the `!redisLegRan && burnedInMemStore &&
redis` branch, so asserting it was NOT called is exactly the pin that the one burn which
ran was arbitrated by a resolving `GETDEL` on the Redis tier rather than by the
in-memory fallback. Without it the tests prove one winner without proving the fixture
built the race it describes.

Add the assertion to both tests.

## Acceptance criteria

1. Neither `backend/src/lib/fresh-auth.ts` nor `backend/tests/lib/fresh-auth.test.ts`
   contains a statement of the retired conditional-backup or one-event-retirement model.
   Verify with a wrap-tolerant sweep that collapses comment prefixes and newlines before
   matching, not a single-line grep. Report the technique, not just the phrase searched.
2. The `alreadySpent` release event and the retained direction each have a test that
   fails when the behavior is mutated away.
3. Both split-tier tests assert the compensating delete was not called.
4. Mutation probes run per site against a committed baseline, with `git status` verified
   clean for the target file immediately before every `git checkout --` restore.
5. Typecheck and lint clean. The three fresh-auth suites pass.

## Notes

Items 1 and 2 are comment-only and change no behavior. Items 3 and 4 add assertions
only. No production logic should change in this task; if it does, that is a signal the
prose was describing something real that the code does not do, and it should be raised
rather than silently fixed.

Do not run the full suite concurrently with sibling agents. The per-file `${appTag}:*`
Redis flush collides with other workers, and the parent task already recorded one
deterministic pre-existing failure caused by exactly that collision.

---

Backend implementation signal (2026-09-30, commits `6dd794d3` and `b80ebff1`, both verified ancestors of `main`):

**Item 1.** The comment above `memStore.set` in `issueSessionFreshAuthToken` now uses the consent-op site's unconditional wording and the dead-code clause is gone.

**Item 2.** The `drainSpentConsentOps` docblock states both release events and scopes itself to the one the drain can produce.

**Item 3, with one deviation from the task text.** The task says the `alreadySpent` release event "is asserted by nothing". That was not the case at the reviewed state: `fresh-auth-redis-unavailable-burn.test.ts` ("a ledger entry refuses the consume itself, with the canonical key still readable") already asserts refused, ledger empty, key gone, and two offline-queue tests assert the ledger empties after a refused replay. Probe m1 below confirms all of them kill the mutation. What was genuinely unpinned is the retained direction. So instead of a standalone duplicate, one new test in `fresh-auth.test.ts` ("a spent-proof ledger entry survives a presentation whose own GETDEL rejects, and retires on the one whose GETDEL resolves") pins both directions in sequence: the entry and key survive a rejected `GETDEL`, then both go on the resolved one.

**Item 4.** Both split-tier tests assert `expect(delSpy).not.toHaveBeenCalled()`.

**AC1, technique.** A four-lens read-only sweep over both files at `6dd794d3`, each finding then handed to an independent refuter. The mechanical lens extracted every line comment, block comment and test title, stripped comment prefixes, joined consecutive comment lines into single-space paragraphs (217 in the source, 265 in the test), and matched 22 case-insensitive pattern families (conditional-backup: `whenever Redis`, `Redis[- ]success`, `dead code`, `backup.{0,60}(when|if|on|whenever|after|once).{0,40}(succe|healthy|available|resolv|land)` and similar; one-event: `one event`, `only event`, `leaves only`, `only (once|when|on|after|by).{0,80}(DEL|delete)`, ledger/entry near `expir|stale|age|TTL|dispatch` and similar). 49 hits, all read against the code, all false positives. Three semantic lenses then read every statement about the backup write, about ledger retirement, and every line the first commit added. They found two statements the patterns could not: the `isConsentOpSpent` docblock bounding the ledger by "confirmed sweeps" (one event named where there are two) and the cleanup docblock's "under no-Redis ops" (presupposes the conditional backup). Both fixed in `b80ebff1`, along with a space my first commit dropped from a test title. One conditional-backup sentence in the test file (the flap-recovery test's "writes a backup to memStore on Redis-issuance success") was fixed in `6dd794d3`.

**AC2 to AC4, probes.** Run serially in a scratchpad copy built with `git archive 6dd794d3 backend`, restored between mutants with `git show 6dd794d3:<path>` and `cmp`-verified at the end, so the shared checkout was never mutated and no `git checkout --` restore was needed. `b80ebff1` changes only comments and one test title, so the results carry.

| Probe | Mutation in `burnConsentOpEntry` | Killed by |
|---|---|---|
| baseline | none | 109 / 5 / 4 pass |
| m1 | remove `if (redisLegRan) spentConsentOps.delete(token);` | the new test (ledger size after the resolved `GETDEL`), the redis-unavailable-burn test named above, two offline-queue tests |
| m2 | make that delete unconditional | the new test ONLY (ledger size after the rejected `GETDEL`); the other two suites stay green |
| m3 | remove `redisLegRan = true;` | both split-tier tests, each at the new `delSpy` assertion, plus the new test |

**AC5.** Typecheck clean. Lint: 0 errors, 1 pre-existing warning in `src/lib/author-supersession.ts`, untouched. The three suites pass at `b80ebff1` run one file at a time (109, 5, 4). Run as one three-file invocation, the offline-queue suite's first test failed once on a vanished canonical key, which is the per-file keyspace flush collision the task's notes describe, not a regression.

**Out of scope, surfaced to the user rather than fixed.** The sweep confirmed four statements that are false or over-general but belong to neither retired model: the `fresh_auth.redis_getdel_failed` warn string promises "a compensating delete follows" on paths where none is issued (the new test drives one such path); the TTL-expiry describe comment in `fresh-auth.test.ts` says the in-memory guard is bypassed when Redis is available, though a nil reply falls through to it; and the `persistSessionSlide` docblock plus two test comments give "would recreate a key Redis has dropped" as the reason for skipping the write in cases where the key still stands.

## The publish spec never pins the $nextTick mount routing or the template x-ref names (archived 2026-10-05) — clean review at afa2237b; edit-spec observation moot at HEAD

### Architect archive note (2026-10-05)

Review of afa2237b with /ce-code-review (full: correctness, project-standards, testing,
adversarial in-process, julik-frontend-races, learnings). Reviewers read git-show copies
of the reviewed tree, because five later ui(drafts) commits rewrote publish.js and
extended the spec after afa2237b. Zero findings at any severity. The architect
re-measured every signal-block claim in isolated copies at afa2237b: spec 81 passed /
exit 0 / no Errors line; full unit suite 87 files / 1977 tests / exit 0; the $nextTick
unwrap fails `builds one editor per ref present when init runs` with "expected spy to
be called 1 times, but got 0 times", and each x-ref rename fails `declares the x-ref
names _mountEditors reads in the template`. At HEAD c3e921ff the spec runs 99 passed,
the unwrap mutant is still killed, and publish.js still holds exactly one $nextTick
call site and both x-refs, so the count comment's invariant still holds.

Residual, accepted and not filed: the count pins the number of dispatches, not what
runs inside the callback (an inline mount beside an unrelated $nextTick stays green).
The implementer disclosed this survivor class, the comment claims only the count, and
the mount reads $refs after its dynamic import, so production impact is nil.

The implementer's observation about the edit spec's "refs assigned afterwards are inert"
sentence is moot: 4882cd42 replaced edit.js's _editorsInitialized latch with a
mount-generation counter and removed that sentence along with its describe (now `the
form mounts the editors on every render`). Nothing filed. No /ce-compound.

### Task file

**Owner:** ui
**Created:** 2026-09-28

Measured during the architect re-review of the edit-spec mount-coverage
task, by probes in isolated copies (pages-publish spec baseline 76 passed /
exit 0):

- `frontend/src/pages/publish.js` holds exactly one `$nextTick(` call site,
  which schedules `_mountEditors()`, and its template carries the same
  `x-ref="abstractEditor"` / `x-ref="bodyEditor"` pair `_mountEditors`
  reads.
- Unwrapping that `$nextTick` block to a bare `this._mountEditors()`
  SURVIVED the publish spec: 76 passed, exit 0.
- Renaming the template's `x-ref="abstractEditor"` likewise SURVIVED.

This is the twin of the two pins the edit spec now carries in its
`a successful load mounts the editors` describe: the exact-count `$nextTick`
routing assertion and the template `toContain` case over both x-ref names.
`pages-publish.test.js` already has the `_mountEditors teardown-during-init
guard` describe and the mocked `createEditor` harness, but nothing drives
the real mount-scheduling path and nothing reads the template. Mirror the
edit spec's two pins, adapted to publish.js's own structure:

1. A case on the real mount-scheduling path asserting the mount effect
   (`createEditor` once per present ref, `_editorsInitialized` true) AND the
   `$nextTick` routing. Before pinning an exact call count, verify
   publish.js's `$nextTick` call-site inventory on the tested path, and
   state the invariant the count rests on in the comment, no broader than
   what the assertion enforces.
2. A template case asserting the publish page's exported template carries
   both `x-ref` names `_mountEditors` reads.

## Constraints

- `frontend/tests/unit/pages-publish.test.js` only; nothing under
  `frontend/src/`.
- Check the publish spec's harness first: if its component factory does not
  already mock `$nextTick` as a synchronous spy the way the edit spec's
  `createComponent` does, mirror that harness shape; the mock stays
  synchronous either way.
- Comment anchors on stable symbols (`_mountEditors`, `$nextTick`, the
  template export name), never task slugs, hold ordinals, line numbers or
  SHAs; the pre-commit anchor gate refuses otherwise.
- Proof-first in isolated scratchpad copies, never the shared checkout: show
  both mutants surviving before the change and killed after, one fresh copy
  per probe.

## Acceptance criteria

1. Unwrapping the `$nextTick` mount-scheduling block in a scratchpad copy of
   `publish.js` fails at least one test; cite the failing case name and
   message in the signal block.
2. Renaming either template `x-ref` in a scratchpad copy of `publish.js`
   fails the template case.
3. `npx vitest run tests/unit/pages-publish.test.js` reports no Errors line
   and exits 0, with no existing test removed or weakened.
4. The full frontend unit suite exits 0 in an isolated two-level copy.

UI implementation signal (2026-09-30, commit afa2237b):

Landed in `afa2237b` (`frontend/tests/unit/pages-publish.test.js` only; an
ancestor of main, verified with `git merge-base --is-ancestor`). A new
`init mounts the editors` describe holds both pins.

Harness check: the publish spec's `createComponent` already mocks
`$nextTick` as a synchronous spy (`vi.fn((fn) => fn && fn())`), the same
shape as the edit spec's, so the harness is unchanged.

`$nextTick` inventory on the tested path: `init` holds publish.js's only

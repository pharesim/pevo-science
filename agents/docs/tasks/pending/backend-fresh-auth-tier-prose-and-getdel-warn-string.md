# Correct four over-general fresh-auth tier statements, including the getdel-failed warn string

**Owner:** backend
**Created:** 2026-09-30

Filed from the prose sweep run for `backend-fresh-auth-retirement-contract-prose-and-pins`.
That sweep confirmed four statements that are false or over-general about the code but
belong to neither retired model that task covered, so they were surfaced to the user
instead of fixed there. The user asked for them to be filed.

## Why

Each finding was raised by one read-only lens and then upheld by an independent refuter
tracing the code at `6dd794d3`. Items 2 to 4 are comment-only and low severity. Item 1
changes a production log string.

## Scope

### 1. The `fresh_auth.redis_getdel_failed` warn string promises a delete that does not always follow

In `burnConsentOpEntry` (`backend/src/lib/fresh-auth.ts`), the warn in the `GETDEL` catch
says "the in-memory tier arbitrates and a compensating delete follows". It fires on every
rejected `GETDEL`, but the compensating `DEL` is issued only on the
`!redisLegRan && burnedInMemStore && redis` branch, which sits after the `alreadySpent`
early return. Two reachable paths log the message and issue no delete: a replay of a
proof already in `spentConsentOps`, and a burn where the in-memory tier did not hold the
entry. The `fresh-auth.test.ts` test "a spent-proof ledger entry survives a presentation
whose own GETDEL rejects, and retires on the one whose GETDEL resolves" drives the first.

Fix: reword so the message is true on every path that emits it. Suggested by the
refuter: "the outcome is decided in-process, and a compensating delete follows only when
the in-memory tier wins a proof not already recorded as spent". Check whether any test
or log consumer matches on the current string before changing it.

### 2. The TTL-expiry describe comment says the in-memory guard is bypassed when Redis is available

In `backend/tests/lib/fresh-auth.test.ts`, the comment opening the
"TTL-expiry on in-memory fallback" describe says that when Redis is available its `EX`
TTL is authoritative and the `cached.expiresAt > Date.now()` guard is bypassed.
`readFreshAuthEntry` returns early only on a non-nil `GET`. A nil reply, which is what an
expired key produces, falls through to `memStore`, where the unconditionally written
backup can still sit until the next cleanup tick and that guard is the only refusal. The
same comment's "consume sees Redis unavailable" is also loose: the tests make the `GET`
reject, with the availability predicate left real.

Fix: state that the guard is reached whenever the Redis read does not return the entry
(nil reply, rejected read, or a leg never attempted), and that these tests reach it by
making the `GET` reject.

### 3. The `persistSessionSlide` docblock gives one cause for a three-case skip

The docblock says the Redis write is skipped when the read came from the in-memory tier
because "writing there would recreate a key Redis has already expired". The in-memory
tier answers in three cases: nil reply, rejected read, and a Redis leg never attempted.
Only in the first is the key known absent, and even then expiry is one cause among
several. In the flap cases the canonical key is typically still standing.

Fix: give the reason that holds in all three cases, which is that the consume has no
evidence the canonical key still exists, so a plain write could plant a key Redis has
dropped or never held. The skip itself is correct and must not change.

### 4. Two test comments repeat item 3's over-generalisation

In `backend/tests/lib/fresh-auth.test.ts`: the file header's "Persistence rules for a
slide" bullet, and the comment inside the slide-persist test that asserts no Redis write
when the in-memory tier answered. The second is false of its own setup: the token is
minted against healthy Redis and only `redis.get` is stubbed to reject, so the key is
still standing when the in-memory tier serves the consume.

Fix: align both with the item 3 wording. In the test body, say that here the key does
still exist and the consume simply cannot know it.

## Acceptance criteria

1. Each of the four statements is true of the code on every path it describes.
2. No production logic changes. Item 1 changes a log message string only.
3. Replacement prose follows the root `CLAUDE.md` "Comment anchors" rules.
4. Typecheck and lint clean. The three fresh-auth suites pass, run one file at a time.

## Notes

Do not run the three fresh-auth suites in one invocation or alongside sibling agents.
The per-file `${appTag}:*` Redis flush collides across files.

`backend-fresh-auth-module-split` (in `blocked/`) requires that no other task hold an
open diff against `fresh-auth.ts`. This task is such a diff until it is archived.

---

Backend implementation signal (2026-09-30, commit `83e3ce9a`):

All four items landed in `83e3ce9a`, which is an ancestor of `main`
(`git merge-base --is-ancestor 83e3ce9a main`). The diff is one log message string
in `backend/src/lib/fresh-auth.ts` plus comments in that file and in
`backend/tests/lib/fresh-auth.test.ts`. No logic changed.

- Item 1: the warn string uses the refuter's suggested wording. No test, frontend
  file, contract doc, or `ARCHITECTURE.md` passage matches the old or new string.
- Item 2: the describe comment also states the no-Redis arm. Neither test in that
  describe is `skipIf`-gated, so without Redis no spy is installed and the guard is
  reached through the never-attempted leg, not a rejected `GET`.
- Items 3 and 4: wording is "answers only when" (the three cases are necessary, not
  sufficient, since the tier must also hold an unexpired copy) and "a plain write"
  (the `XX` write the Redis-served leg issues cannot plant an absent key).

A read-only refuter per item plus a diff-scope check ran against the first draft.
Three of the four refuters found an over-general clause (the three points noted
above); those were fixed before the commit. The corrected wording was not sent
through a second refuter pass.

Verification: `npm run typecheck` and `npm run lint` exit 0. The three fresh-auth
suites pass run one file at a time, exit 0 each, none skipped: `fresh-auth.test.ts`
109, `fresh-auth-redis-unavailable-burn.test.ts` 5,
`fresh-auth-consent-op-burn-offline-queue.test.ts` 4. After the wording fixes only
typecheck, lint and `fresh-auth.test.ts` were re-run (comment-only delta).

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed `83e3ce9a` via `/ce-code-review` (full: correctness, project-standards, adversarial
in-process, learnings). Reviewers read git-show snapshots at `83e3ce9a`. Items 1 to 3 are
FIXED and true on every path: the new warn string matches the compensating-`DEL` condition
exactly, no test, frontend file, contract doc or `ARCHITECTURE.md` matches the old or new
string, the TTL-expiry describe comment matches `readFreshAuthEntry` (which returns the raw
`GET` string unparsed, so the three cases are complete), and the `persistSessionSlide`
docblock's reason holds in all three cases. A TypeScript AST leaf comparison of base and head
finds one changed leaf, the log string literal, so no logic changed. The three suites pass at
`83e3ce9a`, run one file at a time on an isolated Redis DB: 109, 5, 4, exit 0 each. AC 2, 3
and 4 are met. Item 4 is partly met, and one sibling of item 1 is added at triage.

1. **The in-memory-slide test comment drops the "plain write" qualifier.** The comment opening
   the test "a slide served from the in-memory tier is NOT written back to Redis" in
   `backend/tests/lib/fresh-auth.test.ts` says a consume served from that tier "has no evidence
   the canonical key still exists, so it must not write". Lacking that evidence rules out a
   plain write only, since an `XX` write cannot plant an absent key, which is why this commit
   narrowed the `persistSessionSlide` docblock and the file header bullet to "a plain write".
   This comment is the one site the narrowing missed, so item 4 ("align both with the item 3
   wording") is incomplete.
   Fix: replace "so it must not write." with "so a plain write could plant a key Redis has
   dropped or never held, and the persist issues no Redis write at all from this tier." Keep
   the following "Here the key does still exist ..." sentence as it is. Do not add an account
   of why an `XX` write is also skipped; that would be a new docblock claim this task did not
   ask for.

2. **The `burnConsentOpEntry` docblock repeats the over-claim item 1 removed from the warn
   string.** The paragraph on the two failures that land on the "Redis leg did not run" branch
   ends "Both cases leave the in-memory tier arbitrating the win with a canonical copy possibly
   still standing, so both issue the compensating `DEL`". Neither case always issues it: a
   replay of a proof already in `spentConsentOps` returns at the `alreadySpent` branch first,
   and a burn whose in-memory delete returns false wins nothing. A later paragraph names the
   `alreadySpent` branch, so this is imprecise rather than a false contract, but it is the
   exact unconditional "a compensating delete follows" this task was filed to retire.
   Fix: give that clause the warn string's condition, for example "In both cases a canonical
   copy may still be standing, so a burn whose in-memory delete wins a proof not already
   recorded as spent issues the compensating `DEL`, guarded on the client's existence rather
   than its readiness: ..." and keep the rest of the sentence. Re-read the whole docblock
   against `burnConsentOpEntry` after the edit, since the paragraph after it ("That delete is
   best-effort ...") refers back to this one.

Both items are comment-only. Re-run typecheck, lint, and `fresh-auth.test.ts` (one file).
Anchor any new prose on stable symbols only.

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

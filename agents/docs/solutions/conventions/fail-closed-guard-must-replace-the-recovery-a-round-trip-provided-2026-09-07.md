---
title: "A fail-closed guard added upstream of a round-trip deletes whatever recovery lived in that round-trip's error path"
date: 2026-09-07
category: conventions
module: frontend/src/lib/fresh-auth.js + its consumers
problem_type: convention
component: frontend_stimulus
severity: high
root_cause: missing_workflow_step
resolution_type: code_fix
applies_when:
  - Adding a type, shape, allowlist, or schema guard whose failure branch RETURNS in front of code that would otherwise have made a network call
  - Converting a downstream 4xx into a local refusal, on the reasoning that the client can already tell the request will be rejected
  - The guarded value can arrive from a store that outlives the call (a cache, sessionStorage, a module-level memo) and the only thing that un-poisons that store is a downstream rejection handler
  - Reviewing a diff that closes a fail-open direction, and asking whether retrying the same input afterward still reaches a working state
  - A guard names a CLASS of values and its spec exercises one member of that class
symptoms:
  - A truthy non-string in the window cache is refused on every later read once the guard sits between the cache and the caller, and retrying is not an exit
  - The regression is invisible in the diff, because the deleted behavior was never named as recovery anywhere; it fell out of a generic remintable-401 handler two modules downstream
  - Narrowing the guard to the one member of its class that cannot reach the cache or the wire leaves the whole suite green
  - A spec asserting only that the guard refuses stays green through the entire regression, because the regression is in what the refusal leaves behind
related_components:
  - authentication
  - development_workflow
tags:
  - fresh-auth
  - session-window
  - fail-closed
  - cache-poisoning
  - recovery-path
  - round-trip
  - mutation-probes
---

# A fail-closed guard added upstream of a round-trip deletes whatever recovery lived in that round-trip's error path

## Context

`ensureSessionWindow` in `frontend/src/lib/fresh-auth.js` is the acquire-before-commit gate for
light accounts. It resolves the window through `acquireSessionProof` and answers either
`{ ready: true, proof }` or one of the registered non-ready outcomes. Classification is a lookup:
`acquisitionOutcomeKey` reads `WINDOW_OUTCOME_BY_SENTINEL`, so a result the vocabulary does not
name classifies to `null`, and before the fail-closed guard existed such a result fell through to
the ready shape and travelled on AS the proof.

Two legs can produce a non-string there, and neither type-checks what passes:

- **The cache leg.** `readSessionWindow` drops the entry when
  `!token || !expiresAt || !absoluteExpiresAt`, then runs `Number.isFinite` over both deadlines
  and `idlePeriodMs`. The DEADLINES are type-checked; the TOKEN gets only a truthiness test. A
  truthy non-string in the window slot is handed back as a proof by `getCachedSessionProof`.
- **The mint leg.** At the time, the mint callback inside `acquireSessionProof` called
  `cacheSessionProof` with `issued.fresh_auth_proof` and then returned that value verbatim. Nothing
  along that path, from the response to the value's return, inspected its type. The one type test
  the mint path did perform sat in `beginPasswordMintReport`, and it existed to veto a
  password-factor memo write rather than to qualify a proof. (The callback now narrows what it
  RETURNS to a non-empty string or `undefined`, while still writing the raw value; see "Where the
  eviction lives now" below.)

What happened next used to be self-healing, by accident. The non-string reached
`uploadFileToIpfs` in `frontend/src/api.js`, whose light-account branch sends
`body: JSON.stringify({ ...descriptor, fresh_auth_proof: freshAuthProof })`. The backend applied
its own test in `consumeFreshAuthTokenForSurface` (`backend/src/lib/fresh-auth.ts`):
`if (!token || typeof token !== 'string' || token.length === 0)` returns
`{ valid: false, reason: 'missing' }`. That reason is a member of the frontend's
`REMINTABLE_REASONS`, so `uploadFile` in `frontend/src/lib/ipfs-upload.js` matched the 401, called
`clearCachedSessionProof()` (gated on `!guard.tornDown()`), and retried. The poisoned entry was
evicted by the ERROR PATH of the round-trip, and the retry succeeded.

Nobody designed that as poisoned-cache eviction. It fell out of a generic handler whose stated job
is "the window was rejected: drop it and re-acquire". Evicting a CORRUPT entry was a side effect
nothing named.

Then a review round closed the genuine fail-open direction with a refusal at the end of
`ensureSessionWindow`:

```js
if (typeof proof !== 'string') return { ready: false, failed: true };
```

Correct in isolation: it stops an unregistered result from being delivered downstream as if it were
a proof. But `windowProof` in `ipfs-upload.js` throws the moment the outcome is non-ready, so
`uploadFileToIpfs` is never called, so the 401 never arrives, so the remintable branch never runs,
so `clearCachedSessionProof()` never fires. The same entry is re-read and re-refused on every later
attempt. Retrying is not an exit.

The lockout is bounded, and the bound is not short. `anchoredSpan` clamps the idle span into
`[450_000, 900_000]` and the absolute span into `[3_600_000, 7_200_000]`, so for any entry
`cacheSessionProof` wrote, `readSessionWindow`'s `closesAt = Math.min(idleTs, absoluteTs)` always
selects the IDLE deadline. Both `slideSessionWindow()` call sites run only after a SUCCESSFUL
consume, so a refused entry's deadline never advances. The remaining exits are signing out, which
scrubs the slot because `SESSION_PROOF_KEY` is in `SUBJECT_BOUND_STORAGE_KEYS`, and a fresh tab,
because the slot is `sessionStorage`. A self-healing condition had become up to a quarter-hour of a
dead upload button with no in-app way out.

The fix is one call, using the module's own exported clear (it delegates to `dropWindow`, which
removes the `sessionStorage` entry and the in-memory mirror together, and it is the same call the
sibling remintable-401 paths make):

```js
if (typeof proof !== 'string') {
  clearCachedSessionProof();
  return { ready: false, failed: true };
}
```

(`git log -S clearCachedSessionProof -- frontend/src/lib/fresh-auth.js` recovers the change and the
round of comment corrections that followed it.) The reviewers who caught it put it in one sentence:
the guard removed the round-trip without replacing the clear it relied on.

**Where the eviction lives now.** The guard's clear was the whole eviction for one round only. The
broadcast unwinder `acquisitionAborted` reads the same raw acquisition result and applies the same
string test, but it never cleared, so a poisoned slot the broadcast surface refused stayed poisoned
until a page gate or upload pre-flight happened to run the guard. A follow-up moved the eviction
one level up, into `acquireSessionProof`: `evictUnnamedAcquisition` runs `clearCachedSessionProof()`
on both the cache-hit leg and the settled-flight leg whenever the result is a non-string the outcome
vocabulary does not name, before any consumer sees the value. The guard keeps its own
`clearCachedSessionProof()` as a deliberate restatement, so the gate answers for its refusal without
a reader having to trust an eviction they cannot see from there. Measured at the current tree in a
scratchpad copy (the fresh-auth spec files): deleting the guard's clear kills nothing; deleting the
acquisition-level drop kills five, all broadcast-path specs. The load-bearing clear is the
acquisition-level one; the eviction spec quoted under Guidance (`the refusal evicts the entry that
caused it`) is satisfied by either. In the same period the mint
callback was narrowed to return only a non-empty string (`typeof proof === 'string' && proof`),
because the redirect sentinel is `null`, a value JSON can carry, and `''` is the one falsy value
that is also a string. Everything this entry says about WHY the eviction is owed is unchanged; only
its home moved.

## Guidance

**Before adding a fail-closed refusal upstream of a network call, ask what the failure you are
short-circuiting used to do, and whether anything still does it.**

Refusing locally is not free. It is a deletion: the request you prevent is also a rejection you no
longer receive, and the handler for that rejection is code you have just made unreachable for this
input class. Whatever that handler did to make the failure recoverable goes with it.

Run this at the guard site, against the current tree:

1. **Trace where the refused value would have gone.** Name the concrete remote rejection it would
   have drawn: which endpoint, which code, which reason. If you cannot name it, you do not yet know
   what you are removing.
2. **Read that rejection's handler and list its SIDE EFFECTS, not its return value.** Cache clears,
   teardown calls, memo invalidation, retries, generation bumps, counters. The handler's contract is
   usually written in terms of what it returns; the thing you are about to delete is usually in the
   other column.
3. **For each side effect, decide explicitly: reproduce it at the guard, or state why it is not owed
   here.** Reproduce it by calling the SAME exported helper the handler calls
   (`clearCachedSessionProof`, not an inline `sessionStorage.removeItem`), so the two paths cannot
   drift on what "clear" means. Where it is genuinely not owed, say so in the comment, because the
   next reader will run the same check.

The corollary worth stating on its own: **a refusal that does not remove its cause is a lockout, not
a refusal.** When the guard's input can come from a store that outlives the call, refusing without
evicting converts a one-shot failure into a sticky one, and the user's only available action is
precisely the one that cannot help.

**Which stores can strand you is a property you can read off the code.** In this module the three
are not alike. `_acquireInFlight` releases its slot in a `finally`, so it self-heals on the next
call. The window cache releases on nothing a caller does: it drops when its own deadline passes or
when the entry is unreadable, and otherwise waits for an explicit `clearCachedSessionProof()`. And
`_passwordFactorMemo` has two call sites outside its own definition: the subject scrub in
`frontend/src/auth.js`, and the mint route's own eraser in `mintViaPasswordFactor`, which retires
the memo on a second consecutive rejection of the password. That second eraser is itself recovery
that lives in a round-trip's error path, so it is exactly the kind a guard upstream of the mint
would delete. A short-circuit added upstream of a mint is harmless for the first and strands the
other two. Check the release mechanism, not the intuition that "a retry will sort it
out". (session history)

The matching test shape is cheap and should be standard for this class of guard: assert not just
that the first call refuses, but that the SECOND call is an ordinary success.

```js
it('the refusal evicts the entry that caused it', async () => {
  seedWindow(4242, { idleInMs: IDLE_MS });

  expect(await ensureSessionWindow()).toEqual({ ready: false, failed: true });
  expect(cached()).toBeNull();

  // And the next attempt is an ordinary acquisition rather than a second
  // refusal of the same poisoned entry.
  expect(await ensureSessionWindow()).toEqual({ ready: true, proof: 'window-proof' });
});
```

The second assertion is the one that fails when the eviction is dropped. Without it, a spec that
only checks `{ ready: false, failed: true }` stays green through the entire regression, because the
regression is not in the refusal, it is in what the refusal leaves behind.

**Say why a companion clear is or is not gated.** The module's one GATED
`clearCachedSessionProof()`, the remintable-401 eviction in `broadcastWithFreshAuth`, is wrapped in
`if (!guard.tornDown())`, so a departed subject's late response cannot wipe a successor's freshly
minted window: a real network round-trip sits between the window it read and the clear it runs.
The guard's clear and the acquisition-level drop in `evictUnnamedAcquisition` are deliberately
ungated: no `await` separates the acquisition resolving from either clear, so no teardown-plus-mint
can land in between, and the entry being evicted is invalid for any subject by the guard's own
premise. Where a module gates some clears and not others, each ungated one needs that sentence or
the next reviewer re-derives it. (session history)

**When a guard names a CLASS, a pin on one member can pin the UNREACHABLE member.** The guard says
`typeof proof !== 'string'`, and the first spec written for it exercised a `Symbol`. A
`Symbol`-valued field does not survive `JSON.stringify`: it is dropped on the way into the entry
`persistWindow` writes, and dropped again on the way to the wire in `uploadFileToIpfs`. It is the
one member of the class that can reach neither the slot nor the network. Narrowing the
implementation to `typeof proof === 'symbol'` therefore left the whole frontend unit suite green
while a mint response missing its `fresh_auth_proof` read as a ready window with nothing behind it.
Drive the spec from a table across the class, choosing rows for REACHABILITY rather than for how
neatly they illustrate the type, and prove the pin by EXECUTING the narrowing mutation in a private
scratch copy. `control-pair-pins-only-varied-axis-enumerate-mutation-space-2026-06-12.md` states the
general form of this rule.

## Why This Matters

The failure mode is invisible in review by construction. The behavior being deleted was never
written down as a feature: it lived in a handler whose comment describes rejecting a stale window,
not repairing a corrupt one. Grepping the guard's file for the recovery finds nothing, because the
recovery is two modules away and one HTTP round-trip downstream. Nothing in the diff that adds the
guard so much as mentions the cache.

The severity asymmetry is what makes this a convention rather than a one-off note. The direction the
guard closes is real and also self-limiting: an unregistered value delivered downstream produces one
bad request that the backend's own string test rejects, and the client already knows how to recover
from that rejection. The direction the guard opened is not self-limiting: the entry survives, every
later acquisition re-reads it, the deadline never slides because sliding requires a successful
consume, and the escape hatches are signing out or a new tab. The fix traded a failure that healed
itself in one retry for one that persists across every retry until the idle window closes.

This is the general case, not a quirk of this module. Error handlers accumulate cleanup that nothing
documents as the cleanup path, precisely because the handler was written for the common case and the
cleanup happens to be correct for the rare one too. Any guard that prevents an error from occurring
also prevents its handler from running.

For PEvO specifically, this is not preemptive hardening against a theoretical input. Both legs that
can put a non-string into the window slot are live code at the current tree, and the guard-narrowing
mutation was executed and observed surviving rather than reasoned about, which is what separates it
from the preemptive hardening this project dismisses. (auto memory [claude])

## When to Apply

- Adding a `typeof` / shape / allowlist / schema guard in front of code that makes a network call,
  where the guard's failure branch returns instead of calling.
- Converting a downstream 4xx into a local refusal. That is exactly the move that deletes the
  rejection handler.
- Adding an early return to a pre-flight or gate function that other layers wrap with retry,
  eviction, or teardown logic.
- "Moving validation earlier" or "failing fast" on any value that can arrive from a cache,
  `sessionStorage` / `localStorage`, a module-level memo, or any other store that outlives the call.
- Reviewing a diff that does any of the above. The question for the author is the spine of this
  entry: what did the failure you are now short-circuiting used to do, and does anything still do it?
- A guard names a class of values and the accompanying spec exercises one member of it. Check
  whether the pinned member is the reachable one.

It does NOT apply when the refused value has no persistent home. A guard over a value computed
locally within the same call, with nothing cached and nothing to evict, owes no cleanup: refusing is
the whole remedy. Establishing that still costs one pass over the downstream handler.

## Examples

**Before, the accidental recovery.** No guard; a poisoned window entry heals itself through the
network:

```
readSessionWindow   -> token 4242 (truthy, never type-checked) -> returned as proof
ensureSessionWindow -> acquisitionOutcomeKey(4242) === null -> { ready: true, proof: 4242 }
uploadFileToIpfs    -> POST /api/ipfs/upload-token { ..., fresh_auth_proof: 4242 }
backend             -> typeof token !== 'string' -> { valid: false, reason: 'missing' } -> 401
uploadFile          -> REMINTABLE_REASONS.includes('missing')
                    -> clearCachedSessionProof()   <-- the eviction, incidental
                    -> retryOnce(file, guard)      -> succeeds
```

**The regression.** The guard lands, the request never leaves, and the eviction goes with it:

```
readSessionWindow   -> token 4242 -> returned as proof
ensureSessionWindow -> { ready: false, failed: true }        (entry still in the slot)
windowProof         -> throws UPLOAD_REAUTH_FAILED           (no request is built)
uploadFile          -> catch never sees FRESH_AUTH_REQUIRED  (no clear, no retry)
next attempt        -> readSessionWindow returns 4242 again  -> same refusal
...                 -> until the idle deadline, sign-out, or a new tab
```

**The mutation probes that established each piece was load-bearing**, run in private scratch
copies of the checkout rather than in the shared tree, as measured when the guard's clear was the
sole eviction:

| Mutation | Specs killed |
|---|---|
| drop `clearCachedSessionProof()` from the guard | 1 (exactly the eviction spec) |
| narrow to `typeof proof === 'symbol'` | 3 |
| weaken to `proof === undefined` | 3 |
| delete the guard entirely | 4 |

The first row was the point of the eviction spec: without that spec the row read 0, and the
regression this entry documents landed green. Since the eviction moved into
`evictUnnamedAcquisition`, that row reads 0 even with the spec (either clear satisfies it), and the
row that reads non-zero is deleting the acquisition-level drop; the eviction is still pinned, by a
different mutant. The second row is the point of the class table: with only the `Symbol` row present
it also reads 0.

```js
it.each([
  { label: 'a mint response with no proof field', value: undefined },
  { label: 'a numeric proof', value: 4242 },
  { label: 'a null proof field', value: null },
  { label: 'a sentinel nobody registered', value: Symbol('an outcome nobody registered') },
])('an acquisition result the vocabulary does not name refuses the work: $label', ...);
```

## Related

- `atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md` states the same
  meta-principle in the backend Redis domain: when you remove or split a step for a reason unrelated
  to what that step was buying, name what it was buying and re-establish it on the narrowed path.
  This entry is the frontend cache-and-guard instance of it.
- `control-pair-pins-only-varied-axis-enumerate-mutation-space-2026-06-12.md` is the general form of
  the class-versus-member pinning rule above.
- `outcome-vocabulary-widening-requires-a-consumer-audit-2026-08-31.md` covers the same function
  from the opposite direction: adding a MEMBER to the outcome vocabulary obliges an audit of every
  consumer. The cache read is a consumer that the original guard's audit missed.
- `fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md` is the same "a guard in this
  file has a blind spot" shape for a teardown guard rather than a type guard.
- `composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md` for why a probe
  that kills something is not yet a probe that covers each branch.

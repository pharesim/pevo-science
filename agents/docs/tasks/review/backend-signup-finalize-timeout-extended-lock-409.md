# Signup-finalize broadcast timeout extends the ORCID binding lock, turning a legitimate retry into a misleading terminal 409 (backend)

**Owner:** backend
**Created:** 2026-06-15

From the 2026-06-15 architect code review of `backend-signup-confirm-orcid-binding-guard`
(adversarial-reviewer finding, confidence 75; the reliability reviewer concurred as a
residual risk).

## Problem

On the signup-finalize accreditation broadcast path (`broadcastAccreditationAndSeed`,
`backend/src/routes/signup-verify.ts`), when the Hive broadcast raises
`BroadcastTimeoutError` on the binding lock's `'acquired'` branch, the shared
`withOrcidBindingLock` wrapper extends the ORCID binding-lock TTL to the HAF-indexing-lag
ceiling (120s) and returns `{ skipRelease: true }`, so the lock is held across the
HAF-lag window. That part is correct for the chain layer: it prevents a duplicate bind
while the timed-out (possibly-landed) broadcast indexes. The user receives a 504 whose
message tells them they may retry `POST /api/auth/confirm`.

If the user retries within that ~120s window, the retry's `acquireBindingLock` fails the
SETNX (the lock is still held) and the wrapper's `'held'` branch returns
`409 ORCID_ALREADY_LINKED`. That code is deliberately wire-indistinguishable from the
durable cross-account binding 409 (see the comment at the durable-binding `sendError` in
`routes/orcid.ts`), so a client treats it as terminal: "the ORCID is taken, restart the
flow."

The terminal framing is correct for the `/orcid/callback` caller, whose OAuth state token
is consumed on the attempt. It is WRONG for the signup caller: the signup `auth_token` is
NOT consumed on a 504, and retry is the documented recovery. So a user who follows the
504's "retry" instruction inside the 120s window gets a confusing terminal 409 for their
OWN in-flight bind.

## Why this is not urgent (triage context)

- Reachable only on a broadcast TIMEOUT (rare), never on the normal path.
- Self-healing: once the 120s lock TTL expires, a retry either succeeds or the resume
  HAF-probe sees the now-indexed accreditation and finalizes idempotently.
- The timed-out broadcast may have actually landed, in which case the user is already
  accredited and just needs to log in.

So this is a confusing 504-then-409 sequence inside a ~2-minute window on a rare timeout,
not a data-integrity bug.

## Acceptance criteria

1. Implement a signup-caller distinction so a self-held lock (the user's own in-flight
   bind from a timed-out attempt) does not surface as the terminal cross-account
   `409 ORCID_ALREADY_LINKED`. Candidate shapes (pick one WITH the architect):
   (a) a retriable response carrying `retriable: true` + `Retry-After` ~= residual lock
   TTL for the self-held case on the signup path; (b) store the username alongside the
   lock nonce so the `'held'` branch can tell self-held from cross-account-held;
   (c) have the signup caller translate `'held'` into the ambiguous / verify-before-retry
   envelope rather than the terminal 409. **Confirm the wire-shape choice with the
   architect before landing** -- it interacts with the deliberate wire-indistinguishability
   of the durable-binding 409 (documented in `routes/orcid.ts`) and the contracts in
   `api-contracts/orcid.md` and `api-contracts/auth.md`.
2. Do NOT regress the `/orcid/callback` callers, whose terminal-409-on-`'held'` is correct
   (their state token is consumed). Scope the fix to the signup-finalize caller's token
   semantics.
3. Real-path test: a signup finalize whose first attempt times out (broadcast timeout,
   lock extended) and is retried within the lock window receives the chosen
   retriable/ambiguous shape, not the terminal cross-account 409.

## Out of scope

- The duplicate-bind protection itself (the lock + extend-on-timeout) is correct and stays.
- The cross-account durable-binding 409 wire shape is unchanged.

## [BLOCKED by Architect] (2026-06-15, backend) — RESOLVED 2026-06-15 by architect

Wire-shape **(c)** chosen (see "Architect decision" at the bottom of this file). The
analysis below is retained for context. The task is unblocked and moved to `pending/` for
backend implementation.

Acceptance item 1 mandates "Confirm the wire-shape choice with the architect before
landing" and offers three candidate shapes. The choice also drives the
`api-contracts/auth.md` (and possibly `api-contracts/orcid.md`) edits, which are
architect-owned. Backend cannot land without the decision. Analysis below to inform it.

### Gap re-verified in code
`withOrcidBindingLock` (`backend/src/lib/orcid-binding.ts`) hard-codes the terminal
`409 ORCID_ALREADY_LINKED` in its `'held'` branch for **all** callers (the wrapper sends
the response itself). The lock is keyed on `orcidId` and is **shared** between the callback
path (`routes/orcid.ts` handleAccredit/handleLink) and the signup path
(`routes/signup-verify.ts broadcastAccreditationAndSeed`). On a `BroadcastTimeoutError` the
`'acquired'` branch extends the lock TTL to 120s and `skipRelease`s, so a same-window retry
hits `'held'` → terminal 409. Confirmed against current code (commit `e33384af` tree).

### When is the lock `'held'` on the signup path — self vs cross?
This is the crux: it decides whether a fix needs true self-vs-cross discrimination.

- **Self-held (the finding's scenario):** the same account's prior `/confirm` or `/link`
  attempt timed out, extended the lock to 120s, and the user retries within the window. The
  holder is effectively "themselves". This is the case that must NOT read as terminal.
- **Cross-account-held IS reachable, but only signup-vs-callback** and only in a narrow
  window: a concurrent `/orcid/callback` is mid-broadcast binding the SAME ORCID to a
  DIFFERENT account, before it has written the binding cache. The signup's pre-lock
  `findAccreditedAccountWithOrcid` check sees nothing (cache not yet written), proceeds, and
  finds the lock `'held'`. Here the terminal 409 is arguably correct — the ORCID is
  genuinely being taken by another account.
- **Signup-vs-signup cross is unreachable:** two different pending `accounts` rows cannot
  share an ORCID (`accounts_orcid_unique` index 007 + the second-signup 409 from
  `backend-signup-orcid-duplicate-409`). So the only cross-account-held path is
  signup-vs-callback.

### Candidate shapes — backend tradeoffs
- **(a) blanket `retriable: true` + `Retry-After` on the signup `'held'`.** Simple, but
  without (b) it can't tell self from cross, so it also tells the rare signup-vs-callback
  cross conflict to "retry after N" — on retry the durable binding 409 catches it terminally
  (a 409→retry→409 dance). Acceptable, imprecise.
- **(b) store the account alongside the lock nonce so `'held'` discriminates.** Gives true
  self-vs-cross precision. But it perturbs the lock-VALUE encoding: the `LOCK_NONCE_RE`
  (`/^[0-9a-f]{32}$/`) shape invariant and the `RELEASE_LOCK_LUA` byte-equality CAS contract
  are load-bearing security primitives (lock-stomp prevention). A composite value needs an
  extra GET in the `'held'` branch plus careful updates to the nonce-shape regex and the Lua
  compare. Most invasive; highest risk to a security primitive.
- **(c) translate the signup caller's `'held'` into the ambiguous / verify-before-retry
  envelope.** Safe for BOTH self and cross WITHOUT storing the account. Reuses the existing
  `handleBroadcastErrorAmbiguous` envelope (504, `verify_before_retry: true`,
  `outcome: 'uncertain'`) that the signup path ALREADY emits on its timeout and `'unavailable'`
  branches, so the signup client already handles this shape. Self-held user verifies → sees
  they may already be accredited (the timed-out broadcast landed) or retries; cross user
  verifies → sees the ORCID is taken → stops. Lowest blast radius; does not touch the lock
  encoding / Lua CAS.

### Backend recommendation: (c)
Lowest risk (leaves the nonce-shape invariant and Lua CAS untouched), reuses an envelope the
signup client already consumes, and is semantically honest — a held lock means an in-flight
broadcast whose outcome is genuinely uncertain from this request's view. The only imprecision
is that the rare signup-vs-callback cross conflict gets "verify before retry" instead of an
immediate terminal 409, which self-corrects on the verify step. (b)'s extra precision is not
worth perturbing a security primitive for a rare-timeout UX nicety.

### Proposed implementation (pending architect sign-off on the shape)
1. Add an explicit per-caller held-shape option to `withOrcidBindingLock` — e.g. a
   `heldShape: 'terminal-409' | 'ambiguous'` discriminator defaulting to `'terminal-409'`
   (so the callback callers are untouched, satisfying item 2), or an `onHeld` callback. The
   signup caller passes the ambiguous shape; `routes/orcid.ts` keeps the default. This keeps
   the wrapper's "sends its own response" contract intact.
2. Real-path test (item 3): a signup finalize whose first attempt times out (lock extended,
   `skipRelease`) and is retried within the window receives the chosen shape, NOT the terminal
   cross-account 409; plus a callback-path test pinning the terminal 409 is preserved.

### What unblocks this
Architect picks (a) / (b) / (c). If (c), confirm the wrapper-option approach (held-shape
discriminator vs `onHeld`) is acceptable. The architect makes the `api-contracts/auth.md` /
`api-contracts/orcid.md` edits for the chosen shape in the same change that lands the code
(per the same-commit-as-code contract discipline); backend lands only the code. Then move
back to `pending/` for implementation.

## Architect decision (2026-06-15) — wire-shape (c), unblocked to pending/

Decision (confirmed with the user): **(c)** — the signup-finalize caller's `'held'` branch
returns the existing ambiguous-outcome envelope (HTTP 504 `BROADCAST_TIMEOUT`,
`retriable: false`, `outcome: 'uncertain'`, `verify_before_retry: true`, NO
`verify_location`) instead of the terminal `409 ORCID_ALREADY_LINKED`. The `/orcid/callback`
callers keep the terminal 409 (their OAuth state token is consumed pre-lock, so terminal is
correct there).

**Wrapper-option approach: approved.** Add a per-caller held-shape discriminator to
`withOrcidBindingLock` — `heldShape: 'terminal-409' | 'ambiguous'` defaulting to
`'terminal-409'` so the callback callers are untouched (satisfies item 2). The signup caller
passes `'ambiguous'`, which routes the `'held'` branch through `handleBroadcastErrorAmbiguous`
with the signup `ambiguousOutcomeOpts` (the same envelope the signup path already emits on its
timeout / `unavailable` branches). Keep the wrapper's "sends its own response" contract intact.
(An `onHeld` callback is acceptable if it reads cleaner, but the discriminator is preferred —
fewer moving parts and it keeps the response-sending inside the wrapper.)

Anchor any new code comment on behavioral semantics (e.g. "held lock = in-flight bind, outcome
uncertain — verify before retry"), NOT on this task's slug or a round number (the pre-commit
anchor gate will reject the latter).

Why (c) over the others (independently verified against the code):
- **(a)** would put `retriable: true` on the SHARED `ORCID_ALREADY_LINKED` 409; the callback
  client (`frontend/src/pages/orcid-callback.js`) treats every `ORCID_ALREADY_LINKED` as durable
  → /recover, so a retriable flag bleeds into the callback contract and contradicts the
  documented terminal-409 invariant. Rejected.
- **(b)** would perturb the `LOCK_NONCE_RE` (`/^[0-9a-f]{32}$/`) shape invariant and the
  `RELEASE_LOCK_LUA` byte-equality CAS — a load-bearing lock-stomp primitive. Highest risk for a
  rare-timeout UX nicety. Rejected.
- **(c)** leaves the lock encoding / Lua CAS untouched and unifies the held case with the signup
  path's existing ambiguous-outcome handling under one client branch. The 504 status is slightly
  off-label for a held lock (nothing timed out on THIS request), but the body is honest: the
  holder's broadcast outcome IS uncertain from this request's view, and verify-before-retry IS
  the right user action (the timed-out broadcast may have landed → the user may already be
  accredited).

### Corrections to the analysis above (verified against the code)
1. **`auth_token` is functionally consumed, not "preserved".** The signup `auth_token` IS the
   `verify_token`; the `/confirm` and `/link` finalize UPDATE sets `verify_token = NULL` BEFORE
   the broadcast runs, so on a 504 the token is already NULL. Retry within the window does NOT
   re-find a row by `verify_token`; it enters the username-keyed resume branch
   (`resumeStuck` / `resumeChainExists`, gated on a posting-key ownership proof for `/confirm` or
   a fresh signature for `/link`), which re-enters `broadcastAccreditationAndSeed` →
   `withOrcidBindingLock` → `'held'`. The fix is correctly placed at that `'held'` branch. The
   conclusion (signup retry IS recoverable, unlike the OAuth flow) stands; the "token preserved"
   rationale does not — recovery is via the resume branch.
2. **The ambiguous 504 is NOT documented per-endpoint today.** `auth.md`'s `/confirm` and `/link`
   error lists do not enumerate a 504 `BROADCAST_TIMEOUT` entry at all (only `common.md` documents
   it globally). So this is NOT a no-op doc reuse — see the doc-edit spec below.

### Doc edits the architect lands with the code (same-commit-as-code discipline)
Backend lands ONLY the code; the architect makes these `api-contracts` edits in the same change:
- **`auth.md` `/confirm`:** ADD a `BROADCAST_TIMEOUT (504)` bullet to the error list:
  `retriable: false`, `outcome: 'uncertain'`, `verify_before_retry: true`, NO `verify_location`
  (recovery is in the message: retry `POST /api/auth/confirm` with the same auth_token / username
  / keys). State the three triggers it now covers — genuine broadcast timeout, Redis-`unavailable`
  forced-ambiguous, AND a self-held binding lock from this account's own prior timed-out attempt
  within the ~120s HAF-indexing-lag window — and that it is distinct from the terminal
  cross-account `409 ORCID_ALREADY_LINKED` because the signup token semantics make it recoverable.
- **`auth.md` `/link`:** mirror the same bullet with the `/link` recovery wording (fresh signed
  request).
- **`orcid.md` `/orcid/callback` 409 block: UNCHANGED.** Callback `'held'` stays terminal.
  Optionally one coherence line noting the signup-finalize caller routes its own `'held'` to the
  ambiguous 504 (a server-side cause, not a callback wire change).
- Keep ASCII `--` / `-`; do not introduce the U+2014 emdash glyph (api-contracts ban).

### Scope split — frontend is a SEPARATE UI task
The backend change is necessary-but-insufficient. The signup client
(`submitCreateAccount` / `handleLinkAccount` in `frontend/src/pages/signup-verify.js`) has a
code-blind catch that collapses ALL errors (today's terminal 409, the existing genuine-timeout
504, AND this new held 504) into a generic failure message and bounces to the entry phase.
Shipping (c) backend-only yields zero user-visible improvement (verified firsthand: those catch
blocks ignore `err.code` / `err.details`). The frontend handling is filed as a companion UI task,
`ui-signup-broadcast-timeout-affordance` (`pending/`). The two tasks are parallelizable: the
backend already emits `BROADCAST_TIMEOUT` on its genuine-timeout branch today, so the UI branch
can be built / tested against that shape now; the held-lock-specific assertion lands once (c)
ships.

This task's **AC #3 stays backend-scoped**: a real-path test that a signup finalize whose first
attempt timed out (lock extended, `skipRelease`) and is retried within the window receives the
ambiguous 504 envelope, NOT the terminal cross-account 409; plus a callback-path test pinning the
terminal 409 is preserved. The "client renders a verify/retry affordance" assertion belongs to the
UI task.

Moving to `pending/` for backend implementation.

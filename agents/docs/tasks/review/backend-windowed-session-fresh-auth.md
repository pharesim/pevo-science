# Windowed session-kind fresh-auth proofs

**Owner:** backend
**Created:** 2026-08-25

## Why

Light accounts currently cannot publish without being bounced to ORCID. `POST /api/custody/broadcast` requires a session-kind fresh-auth proof on the non-consent branch, that proof is single-use (`redis.getdel`) with a 5-minute TTL, and the SPA's only implemented mint factor is a full-page ORCID OAuth redirect. So every publish, vote, comment, review, and edit navigates the user out of the app. State A (light + password, no ORCID, accredited via institutional email, which does not require ORCID) cannot broadcast at all: `handleSessionAuth` 403s because no linked ORCID exists.

The fix is not simply "wire up the password mint". Minting a single-use proof per broadcast means a prompt per broadcast, and the only way to avoid that with single-use proofs is to hold the user's plaintext password in client memory for the duration, which is a worse place for a long-lived secret than the server. The decided design makes the session kind windowed instead.

Design and rationale: `agents/docs/ARCHITECTURE.md` § 6.4.1, § 6.4 (non-consent broadcast row, IPFS upload-token row), § 6.5 invariants #1 and #9. Those sections are authoritative; this file is the work order.

## Scope

Backend only. The UI task is `ui-light-account-reauth-window` and is blocked on this landing.

### 1. Session-kind proof becomes windowed and multi-use

- Sliding idle expiry of **15 minutes**: a successful consume slides the idle deadline forward.
- Absolute cap of **2 hours** from first mint, enforced server-side, not extendable by any client action.
- Consume validates and slides instead of deleting. Whichever deadline is reached first ends the window.
- Store both deadlines with the entry so the cap survives a slide.

The consent-op kind is **unchanged**: `getdel`, single-use, target-bound, 5-minute TTL. `FRESH_AUTH_TTL_SECONDS` currently serves both kinds; split the constants rather than moving the shared one.

### 2. Remove the double-spend lock for the session kind

`inFlightConsumes` in `backend/src/lib/fresh-auth.ts` exists to stop two concurrent consumes of a single-use token, and it returns `expired` to the loser. Once session proofs are multi-use that lock turns legitimate concurrency into spurious 401s: two votes fired in the same tick, or an upload-token mint racing a broadcast, would have one arm rejected with a reason the SPA reads as "re-auth needed". Scope the lock to the consent-op kind, which still needs it.

### 3. Redis and memStore fallback

The dual-write fallback exists so a Redis flap between issue and consume does not produce a spurious `expired` on a proof the user just minted. Keep that property. The "consumed exactly once across both tiers" reasoning no longer applies to the session kind, but the slide must not be lost when a consume is served from memStore, and a memStore-served slide must not resurrect an entry Redis has already expired.

### 4. `POST /api/ipfs/upload-token` accepts a session-kind proof

Accept **either** the existing `ipfs_upload`-targeted consent-op proof **or** a valid session-kind proof within its window. This is what makes inline upload reachable for passwordless state C, whose only factor is a page navigation that a selected `File` cannot survive.

The rationale for the widening is in § 6.4.1: a live session proof already authorizes arbitrary broadcasts for the rest of its window, so an upload is not a wider grant than the holder already has, and the per-file integrity binding lives in the returned upload token rather than in the fresh-auth proof. The consent-op kind stays accepted so the signature path and any non-SPA caller are unaffected.

### 5. Session invalidation must close open windows

`sessions_invalidated_at` (§ 6.7) currently revokes bearer JWTs only. A password reset or recovery that leaves a live broadcast window open has not actually cut off the compromised session. Invalidating a user's sessions MUST also invalidate their outstanding session-kind proofs. Logout should drop the proof server-side too, not just clear the client copy.

### 6. Invariant #9 holds

No login, token-refresh, or signup-finalization path may mint or extend a session-kind proof as a side effect. Only `POST /api/custody/session-auth` (password) and `POST /api/orcid/callback mode='session_auth'` (ORCID) open a window. This is the line that keeps the fresh-auth layer from collapsing into the session layer, and it is worth an explicit test rather than trusting that nobody adds it later.

### 7. Wire contract

Issuance responses need both deadlines so the SPA can decide when to re-auth ahead of a submit rather than discovering expiry mid-flow. Keep the existing ISO-8601 string convention. `expires_at` keeps its meaning as the deadline the client should treat as authoritative for "do I need to re-auth"; add the absolute cap alongside it.

Error codes and status discrimination are unchanged: 401 for `missing` / `expired` / `malformed`, 403 for `username_mismatch` / `kind_mismatch`. A window that hit either deadline reports `expired`.

## Acceptance criteria

1. A session proof minted by password or ORCID authorizes multiple broadcasts without re-minting.
2. Idle beyond 15 minutes between consumes ends the window, reported as `expired`.
3. The window ends at 2 hours after first mint regardless of how many consumes slid it. A test that slides repeatedly across the cap must fail closed.
4. Two concurrent consumes of the same valid session proof both succeed.
5. Consent-op proofs remain single-use, target-bound, 5-minute TTL. A session proof is still rejected on the consent surface with `kind_mismatch`, and a consent-op proof is still cross-kind-accepted on the session surface.
6. `POST /api/ipfs/upload-token` succeeds against a valid session proof and still succeeds against an `ipfs_upload`-targeted proof.
7. Invalidating a user's sessions invalidates their outstanding session proofs.
8. No login or signup-finalize response mints a session-kind proof.

## Testing notes

Per the root `CLAUDE.md` carve-out, TTL and cap behavior are the deterministic-edge-case class that justifies fake timers over real waits; document the justification in the test file header. Auth-focused specs must run the real `verifyHiveSignature`. The window-boundary tests are the ones most worth writing first, since the cap is the security-relevant half of the design and the easiest to implement in a way that silently never fires.

## Contract docs

`agents/docs/api-contracts/custody.md`, `ipfs.md`, and `orcid.md` all describe surfaces this changes: the session-auth issuance response gains a field, the broadcast consume stops being single-use, and upload-token acceptance widens. Those files are architect-owned and describe live wire behavior, so they are updated when this lands rather than ahead of it. Flag the wire-visible changes at review intake so the update is not missed. `settings.md` and `accreditation.md` use the consent-op kind and are unaffected.

---

## Backend completion signal (2026-08-25)

All eight acceptance criteria implemented and covered. Item-by-item:

**1. Windowed, multi-use session kind.** `backend/src/lib/fresh-auth.ts`. Constants split:
`FRESH_AUTH_TTL_SECONDS` (300) stays consent-op-only; new
`SESSION_FRESH_AUTH_IDLE_SECONDS` (900) and `SESSION_FRESH_AUTH_ABSOLUTE_SECONDS` (7200).
`StoredEntry` gains `idle_expires_at` / `absolute_expires_at` (epoch ms), stored with the
entry so the cap survives every slide. The storage TTL tracks `min(idle, absolute)`, so the
cap is enforced by the tier as well as by the explicit consume-side check. The slide is
clamped to the cap.

Both consume helpers now share one implementation (`consumeFreshAuthTokenForSurface`)
parameterised by a `FreshAuthConsumeSurface` (`expectedTargetHash: string | null`,
`acceptSession: boolean`). The read is NON-destructive; the kind is only knowable after
reading, and a `GETDEL`-first read would spend a session window just to discover it was
one. Consent-op entries are then burned (Redis `DEL` reply count / in-memory `Map.delete`
return value arbitrates); session entries are validated and slid.

**1a. Burn atomicity, after adversarial verification.** The first cut split the old atomic
`GETDEL` into a non-destructive read plus a `DEL`, which reopened a consent-op double-consume:
a `DEL` that rejects mid-flight (connection drop, command timeout, retry ceiling) leaves the
canonical entry alive while the in-memory delete still reports a win, so the same proof
authorizes a second critical action once the client reconnects inside the TTL. Because the
per-user targets bind only `(action, actor, '')` and never the payload, the second consume is
not constrained to the same effect. Fixed two ways: the burn's Redis leg is `GETDEL` again, so
a non-nil reply proves the delete landed; and when that leg did not run at all (the client
exists but `isRedisAvailable()` is false during a reconnect) and the in-memory tier arbitrated
the win, a compensating `DEL` is issued guarded on the client's existence ONLY, so ioredis
queues it offline and flushes it on reconnect. The old code had exactly that compensating
delete; dropping it was the regression. Both variants are pinned by tests, the second in its
own file because simulating a not-ready window takes a stubbed readiness predicate.

**2. Lock scoped to the consent-op kind.** `inFlightConsumes` is now acquired only on the
consent-op burn, after the kind is known. Session consumes never enter it, so concurrent
ones both succeed. Structural pins sample the lock-set size from inside the burn (must be
1) and from inside the slide (must be 0), because a dropped `add` and a reinstated lock are
both invisible to outcome assertions on a single call.

**3. Redis / memStore fallback.** The flap-recovery property is preserved and extended to
the slide: a consume served from the in-memory tier still moves the deadline, so a Redis
outage does not silently shorten every window to a single use. A memStore-served slide is
NOT written back to Redis (that tier answers precisely when Redis did not), and a
Redis-served slide uses `SET ... PX ... XX` so a key that lapsed between this consume's read
and its write is not resurrected for another full window.

The `XX` reply is also CHECKED, which turned out to matter more than the flag itself. A
declined write means the canonical entry is gone (lapsed, evicted, or swept by an invalidation
that raced this consume), so the in-memory copy the slide just refreshed is deleted rather
than left to self-renew. Without that check, a password reset landing between an in-flight
consume's read and its write left the window it was supposed to close alive in the backup
tier, invisible to the Redis half of every later sweep. The sweep itself now runs Redis first
and the in-memory tier last for the same reason, with the Redis leg carrying its own catch so
an unreachable Redis cannot skip the one tier this process fully controls.

**4. `POST /api/ipfs/upload-token` widened.** `requireFreshAuth` / `consumeFreshAuthProof`
take an `{ acceptSession }` option; `ipfs.ts` opts in. Exactly one surface gains session-kind
acceptance. A consent-op proof still has to be the `ipfs_upload`-targeted one, so a proof
minted for `change_email` yields `target_mismatch`; another account's proof yields
`username_mismatch`. Both are covered.

**5. Session invalidation closes open windows.** New
`invalidateSessionFreshAuthTokens(username)` sweeps the in-memory tier by username and the
Redis tier via a per-user index (`${appTag}:fresh_auth:user_sessions:<username>`, written
best-effort at mint, expiry equal to the cap). Wired into all three writers of
`sessions_invalidated_at`: `POST /api/auth/reset` and both reissue sites in `recover.ts`.
Placed after the write and before the response, outside the phase-2 transaction (Redis is
not enlisted in it, and a throw inside would abort an otherwise-committable swap). The
helper never throws: the account mutation has already committed, and turning a Redis blip
into a 500 would tell the user a completed reset failed. `reissuedAt` is unaffected, it
reads the pre-write `invalidatedAt` const in both recover handlers.

Consent-op proofs are deliberately NOT swept: target-bound, single-use, and outliving the
reset by at most their own 5-minute TTL.

**6. Invariant #9.** New standing canary
`backend/tests/eslint/no-session-proof-mint-outside-reauth-routes.test.ts` asserts the set
of files calling `issueSessionFreshAuthToken` is exactly `{routes/custody.ts,
routes/orcid.ts}`, plus a named-forbidden-file check over `auth.ts`, `signup-verify.ts`,
`recover.ts`, `verifyHiveSignature.ts`. The exact-set assertion is the load-bearing half
(it catches a mint in a brand-new file); the forbidden list exists so a red bar reads as
"this is invariant #9" rather than "the allowlist needs updating". Audited against the
current tree first: no login, session, signup, finalize, resume-signup, or recovery path
mints or can mint one today. The sharpest edge is `orcid.ts` `handleLogin`, a sibling branch
of the same `/callback` dispatch as `handleSessionAuth` and fed by the same genuine OAuth
round-trip, which is why the canary matches call sites rather than files.

**7. Wire contract.** Both session-auth issuance responses gain `absolute_expires_at`
(ISO-8601 UTC, matching the house `_at` convention). `expires_at` keeps its meaning as the
deadline the client treats as authoritative, which for a session mint is the sliding idle
deadline. Error codes and status discrimination unchanged; both broadcast branches now go
through the shared `freshAuthFailureStatus` instead of duplicating the ternary.

**8. Closed-default stored shapes.** A session entry without deadlines is `malformed`, not
unbounded (a shape written by a deploy that predates the window costs one re-auth rather
than handing out an uncapped window). A consent-op entry that acquired deadlines is also
`malformed`, which is the route by which the strictest proof kind could otherwise turn into
the loosest.

### Verification

`npm run typecheck` (src + tests) and `npm run lint` clean. Suites updated and green:
`tests/lib/fresh-auth.test.ts` (90), `tests/routes/custody-session-auth.test.ts` (8),
`tests/routes/custody-non-consent-fresh-auth.test.ts` (12),
`tests/routes/ipfs-upload-token.test.ts` (21), `tests/routes/orcid.test.ts` (108), plus three
new files: `tests/routes/session-proof-invalidation.test.ts` (7), the invariant-#9 canary (4),
and `tests/lib/fresh-auth-redis-unavailable-burn.test.ts` (2). The consent-op, credit-op,
settings, accreditation-metadata, and admin suites all re-run green, which is the check that
matters most here since they share the consume implementation without sharing the change. The invalidation suite drives all three revocation routes end to end against real
Postgres and Redis with no mocks at all, and carries a standing wiring canary so a fourth
route added later that stamps `sessions_invalidated_at` without sweeping the proofs fails
the suite.

### Decisions taken, for the record

- **Server-side logout is NOT in this change.** Scope item 5 says "logout should drop the
  proof server-side too", but there is no server-side logout: `disconnect()` in
  `frontend/src/auth.js` is purely client-side and no logout route exists. Adding one is a
  new API surface the UI task never mentions, so it would ship unused. Triaged with the
  user, who chose to defer it. **[TODO Architect]** file it as its own task with a UI
  counterpart if the posture is wanted. Note it is defence in depth either way: a session
  proof is inert without a live JWT, since the consume binds it to the authenticated
  username.
- **The slid deadline is not echoed back.** Neither the broadcast nor the upload-token
  response carries a refreshed `expires_at`, so a client cannot observe the slide and must
  model it locally from the idle period it learned at mint. Scope item 7 asked only for the
  issuance responses; flagging it because the contract should say so plainly rather than
  leave a client guessing whether the slide is observable.
- **A `username_mismatch` or `kind_mismatch` on a session proof does not burn it.** Burning
  would let anyone holding the token close the owner's window by presenting it on the wrong
  surface or under the wrong JWT. The consent-op path keeps its previous burn-before-check
  ordering exactly.

  This is a THIRD wire-visible change beyond the two the task enumerates, and it needs saying
  in the contract sweep. Previously, presenting a session proof on a strict surface spent it,
  so an immediate retry of the identical request degraded from 403 `kind_mismatch` to 401
  `expired`. It now keeps returning 403 `kind_mismatch`, and the proof still works afterwards
  on the surfaces that accept it. The 401-vs-403 split routes to different SPA branches
  (401 re-login, 403 wrong-account/wrong-proof), so a client with retry logic sees a different
  path than before. Affects the consent-op and credit-op arms of `/api/custody/broadcast`, the
  three settings consume surfaces, the accreditation-metadata edit, and the admin authority
  actions. A related, concurrency-only flip: two requests presenting the same proof in one tick
  used to have the loser collapse to 401 `expired` because the lock was taken before the read;
  both now report the binding reason. Both follow from scoping the lock to the consent-op burn,
  which the task asked for.

- **Residuals surfaced by adversarial verification, NOT fixed, for triage.** Three, all bounded
  by the absolute cap and all defence-in-depth rather than the primary control (a session proof
  is inert without a JWT that survived the same invalidation, and `verifyHiveSignature` revokes
  those first): (i) a window whose Redis entry is dropped or evicted while the process keeps
  running can continue to be served from the in-memory backup until its cap, because "Redis
  answered nil" is indistinguishable from "the mint's Redis write failed", which is the
  flap-recovery case that must keep working; closing it properly wants a `redis_backed` marker
  on the stored entry. (ii) `invalidateSessionFreshAuthTokens` is best-effort when Redis is
  unreachable, and now says so in the log rather than returning silently; making the closure
  durable across a flap wants a revocation epoch compared at consume time, which the JWT gate
  already reads from Postgres on every authenticated request and could hand to the consume via
  `req`. (iii) a window minted in the gap between the DB write and the sweep survives the
  reset; the same epoch check would close it. All three are one design decision, not three
  patches, which is why they are surfaced rather than taken unilaterally.
- **State D residual, sharpened by verification.** `POST /api/custody/upgrade` nulls the
  encrypted keys and sets `upgraded_at`, but stamps neither `sessions_invalidated_at` nor the
  proof sweep. A window minted minutes earlier therefore survives the one transition that
  revokes every other light-account capability, and since `upload-token` has no `upgraded_at`
  guard, the surviving pair keeps minting upload tokens for the rest of the cap while
  `/broadcast` correctly refuses the identical proof with 403. § 6.4.1 says a session proof
  "dies with the session", so this is a gap in that claim rather than merely a longer version
  of the old one. The holder is the account owner and the old `custody: 'light'` JWT survives
  the upgrade today regardless, so it is not an escalation. **Deliberately not fixed here:**
  stamping `sessions_invalidated_at` at `/upgrade` and embedding `reissuedAt` in the reissued
  token is a behavioural change to a route this task does not name, and it would log out every
  other device at upgrade time. **[TODO Architect]** decide whether `/upgrade` joins the
  invalidation set (and whether `upload-token` should carry an `upgraded_at` guard); it is a
  small, self-contained follow-up either way.

### [TODO Architect] Contract updates

Wire-visible changes, per the "Contract docs" section of this task. Surveyed against the
current text; passage-level detail below so nothing is missed. Two rules bound the whole
sweep: exactly one surface gains session-kind acceptance (`POST /api/ipfs/upload-token`),
and the consent-op kind's contract text must survive verbatim.

There are THREE wire-visible changes, not the two the task's scope section enumerates. The
third is that a session-kind proof rejected on a strict surface is no longer spent, so repeat
presentations keep returning 403 `kind_mismatch` instead of degrading to 401 `expired` on the
second try, and the proof still works afterwards on the surfaces that accept it. `custody.md`,
`settings.md`, `accreditation.md`, and the admin contract text all currently imply the proof is
consumed on every consume path. See the decisions section above for the full reasoning and the
list of affected surfaces.

**`custody.md`**
- `POST /api/custody/broadcast`, proof-binding prose: "The proof is single-use and consumed
  atomically before the broadcast attempt" is now kind-dependent. Split into two sentences:
  a consent-op-kind proof is single-use and consumed before the attempt; a session-kind
  proof is not consumed, it is validated against both deadlines and its idle deadline slides
  forward. The following sentence (400 before consume, staged proof survives) stays correct.
- Same route, the **Single-use proof semantics** block: the burn-on-502/504 paragraph is
  false for the session kind. Retitle it kind-qualified and split: consent-op keeps the
  paragraph verbatim including the `chain-write-timeout-ambiguous-outcome` rationale;
  session-kind proofs are not burned, so a 502 or 504 leaves the proof usable for the rest of
  its window and the caller retries with the SAME proof. SPA retry code needs this stated.
- Same route, the `kind_mismatch` bullet: "Session-kind proofs are scoped to non-consent
  broadcasts only" is now false. Restate as admitted on the non-consent broadcast surface and
  on `POST /api/ipfs/upload-token`, rejected on the consent-op and credit-op surfaces and on
  the settings consume surfaces. Status, code, and reason enum are unchanged.
- Same route, the non-consent bundle bullet: add the reuse semantics, and note it currently
  omits the password mint path `POST /api/custody/session-auth` (pre-existing drift, worth
  fixing while the bullet is being rewritten anyway).
- `POST /api/custody/session-auth` intro: "Mint a target-less session-kind fresh-auth proof"
  should say target-less, windowed, and multi-use; the purpose sentence should add
  `POST /api/ipfs/upload-token` to the surfaces the proof authorizes.
- Same section, the no-target-binding prose: "They are admitted only on the non-consent
  broadcast surface" is false, same two-surface correction.
- Same section, the response JSON example: `"<single-use token>"` is now wrong, and the
  example needs `absolute_expires_at` immediately after `expires_at`. The current
  `12:05:00.000Z` value encodes the old 5-minute TTL; a mint at 12:00 now gives
  `expires_at` 12:15 and `absolute_expires_at` 14:00.
- Same section, the prose under the JSON block: every clause is now wrong. It must say the
  token is multi-use and bound to the JWT subject with no target binding; that it stays valid
  while both deadlines hold, a 15-minute idle deadline each successful use pushes forward and
  a 2-hour cap fixed at mint that no client action extends; that whichever lands first ends
  the window and reports 401 with `details.reason: "expired"`; that `expires_at` is the idle
  deadline as of that response while `absolute_expires_at` is fixed; and that a password reset
  or a recovery reissue ends every outstanding session proof for the account immediately,
  surfacing as the same 401. Widen the submission instruction to include the upload-token
  route.
- `POST /api/custody/fresh-auth` response prose ("single-use ... TTL is 5 minutes"): DO NOT
  EDIT. This is the consent-op kind and it is unchanged. A search-and-replace on "single-use"
  or "TTL is 5 minutes" would corrupt it. Optionally add a contrast clause so an integrator
  reading only this section sees the asymmetry.

**`orcid.md`**
- `/start` mode table, `session_auth` row: "target-less (session-kind)" should say
  target-less, windowed, multi-use; add the upload-token surface. This row also carries two
  em-dashes, which the project forbids in integrator-facing contract text; since it is being
  rewritten, restructure to commas in the same pass.
- `/start` target-field closing paragraph: "admitted only on the non-consent broadcast
  surface" needs the same two-surface correction.
- `session_auth` section intro: clause (b) is false, same correction, and it wants a clause
  (c) for the lifetime divergence. The section is written as a delta against `fresh_auth`,
  which makes it the cleanest place in the file to carry that.
- `session_auth` response JSON block and the prose under it: identical edits to the custody
  siblings. These two pairs are the same wire shape modulo `mode` and `mechanism` and have
  drifted before, so edit them together and keep the two-deadline sentence byte-identical.
- `fresh_auth` response prose and placeholder: DO NOT EDIT, same protection as the custody
  sibling.

**`ipfs.md`**
- Request-body JSON placeholder: `"<ipfs_upload-targeted fresh-auth proof; JWT path only>"`
  asserts the targeted proof is the only accepted value. Make it either/or. No new field.
- Auth section, JWT-path bullet: the most-wrong passage of the four files. Three defects.
  The requirement becomes EITHER an `ipfs_upload`-targeted consent-op proof OR a session-kind
  proof inside its window. The sentence "The per-action binding means a target-less session
  proof minted for a vote or comment cannot be redirected here" is now exactly inverted and
  must be deleted rather than softened, replaced by the reason the widening still satisfies
  § 6.5 invariant #1: a session proof is itself a fresh re-auth artifact, bound to the JWT
  subject and bounded by a window, so a replayable JWT alone still does not reach the action,
  and the per-file integrity binding lives in the returned upload token. The mint-path list
  needs the two session mint routes. The state-C carve-out ("asks passwordless ORCID-only
  accounts to set a password first") is retired per ARCHITECTURE § 6.4.
- Errors, `FRESH_AUTH_REQUIRED` bullet: drop "or the wrong proof kind such as a target-less
  session proof" from the 403 list, and say explicitly whether `kind_mismatch` is now
  unreachable at this route so integrator branch code does not keep a dead arm (it is: the
  surface accepts both kinds, so a wrong-action consent-op proof yields `target_mismatch`).
  "Mirrors the consent-op consume on `POST /api/custody/broadcast`" is now the wrong
  cross-reference; it mirrors the non-consent, cross-kind-accept consume. Widen the 401
  `expired` description to cover a lapsed idle deadline, a reached cap, and a proof killed by
  a reset or recovery.
- Section intro and response block ("single-use token", `expires_in: 60`): DO NOT EDIT. Those
  describe the `upload_token` this route MINTS, a different artifact that stays single-use.

**`common.md`**
- The 401 `SESSION_INVALIDATED` row is not false but now under-describes the blast radius:
  the same overlay also ends every outstanding session proof, and the two revocations surface
  under DIFFERENT codes (`SESSION_INVALIDATED` for the bearer token, `FRESH_AUTH_REQUIRED`
  with 401 and `details.reason: "expired"` for the proof). A client branching on `error.code`
  will get that wrong. No new reason value; the enum is unchanged.

**`auth.md`** (outside the files this task's Contract-docs section named, but the same factual
claim): "Invalidates all existing sessions for the account" under `POST /api/auth/reset` is
now incomplete, as are the equivalent sentences on the ORCID recover path and the
recover/verify response. All three should add that the account's outstanding session-kind
proofs end too.

**`settings.md`**: DO NOT EDIT. The settings consume surfaces are not widened and keep
rejecting session proofs with 403 `kind_mismatch`; their text stays correct.

### [TODO Architect] One solutions entry went stale

`agents/docs/solutions/conventions/concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo-2026-05-19.md`
builds its entire Guidance section
and its mutation-killing example on `_getInFlightConsumesSetReferenceForTests`, and cross-references
the Set-identity anchor spec in `tests/lib/fresh-auth.test.ts`. Both are gone: the hook existed to
pin that BOTH consume helpers locked on the same Set instance, and scoping the lock to the
consent-op burn made that invariant false by design, so the hook and its spec were removed rather
than reworded. The entry's prescribed fix is now unimplementable as written, and its microtask
analysis ("both helpers' catch blocks run synchronously with no intervening await") describes a
per-helper code shape that no longer exists.

Not fixed here: `agents/docs/solutions/` is architect-owned and `/ce-compound-refresh` is the
architect's tool. Narrow scope hint for that run:
`/ce-compound-refresh concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo`. The
underlying lesson (wire-shape assertions are mutation-blind under microtask FIFO, so pin by
reference identity or by sampling state from inside the call) is still correct and still applied in
the current tests, which now sample the lock-set size from inside the burn and from inside the
slide; only the named anchor changed.

A new entry landed in the same pass:
`conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md`, written via
`/ce-compound` for the burn-atomicity regression described above.

**Pre-existing drift surfaced while surveying** (architect's call whether to fold in or file
separately): the `ipfs_upload` and `edit_accreditation_metadata` fresh-auth actions are live
in `backend/src/lib/fresh-auth.ts`, `routes/custody.ts`, and `routes/orcid.ts` but appear in
neither the custody `/fresh-auth` action enum and its `VALIDATION_ERROR` restatement nor the
orcid `/start` and `fresh_auth` response enums. `ipfs.md` actively instructs integrators to
pass `action='ipfs_upload'` to both endpoints, so an integrator following it today is passing
a value the other two contracts call invalid. The `ipfs.md` sentence that points at those
enums is being rewritten anyway, which makes this the natural moment to close the gap.

---

## Architect re-review (2026-08-26) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `51ecba19` (backend paths only), nine reviewer
personas plus a seven-finding independent validation wave. **The design is sound and
all eight acceptance criteria were independently verified as met** (a reviewer re-ran
`tsc --noEmit` clean and the touched suites green rather than taking the completion
signal's word for it). The absolute cap genuinely fails closed, the consent-op burn
held single-use under every constructed interleaving, rolling deploy and rollback both
fail closed, exactly one surface was widened, and project-standards came back clean
(the diff also removes two pre-existing task-slug anchor-rot citations, which is
credited). Nothing below invalidates the architecture; these are durability and
enforcement gaps found on top of it.

Five items. Items 1 and 2 are the ones that block archive.

### Item 1 — Session invalidation must be authoritative from Postgres, not best-effort via Redis

Three separate race windows and one silent failure mode all share a single root fix,
and this task's own "Residuals surfaced by adversarial verification" section already
named it: a revocation epoch compared at consume time. Triaged with the user, who
chose the epoch approach over the narrower per-race patches.

`middleware/verifyHiveSignature.ts` already SELECTs `accounts.sessions_invalidated_at`
on every authenticated request but does not plumb it onto `req`. Attach it, and have
the session consume reject a window whose `issued_at` predates it. `issued_at` is
carried through every slide unchanged, so it is a stable anchor for the comparison.

This supersedes the narrower memStore-ordering patch. It closes:

- **The memStore re-plant.** In `persistSessionSlide`, `memStore.set` runs one line
  before the `fromMemStore` early return, so a consume served by the in-memory tier
  re-plants the entry and never reaches the `SET ... XX` whose declined reply is what
  removes it. Confirmed by an independent validator.
- **The swallowed index write.** ioredis wraps per-command errors into `[err]` tuples
  inside a RESOLVED array, so `multi().exec()` does not reject and the surrounding
  catch plus its `fresh_auth.session_index_write_failed` log are dead code for that
  error class. Verified against installed ioredis 5.10.1. Because there is no
  keyspace-scan fallback and the in-memory tier is empty after any restart, a window
  whose index write failed is unreachable by EVERY invalidation path until its cap.
- Residuals (ii) and (iii) as this file already describes them.

**Also required, independent of the mechanism chosen:** two docblocks currently assert
a guarantee the code does not provide. `persistSessionSlide`'s own docblock and the one
on `invalidateSessionFreshAuthTokens` both claim the `XX` reply check closes the
sweep-versus-in-flight-consume race. It provably cannot reach the memStore-served leg.
Rewrite both to describe whatever the landed control actually is.

Not an escalation path: a session proof is inert without a live JWT and the JWT is
revoked by the same overlay. This is defence in depth plus two false docblocks.

### Item 2 — Both standing canaries assert at file granularity and are blind at their own named worst case

`backend/tests/eslint/no-session-proof-mint-outside-reauth-routes.test.ts` collects a
Set of FILE paths and compares it to `['routes/custody.ts', 'routes/orcid.ts']`. Adding
`issueSessionFreshAuthToken` inside `handleLogin` leaves that Set unchanged, so the
canary stays green. `routes/orcid.ts` cannot go in the forbidden list because it is in
the allowed list. This is the exact scenario the file's own docblock names as most
likely, and the claim in this task's completion signal that the canary "matches call
sites rather than files" is not accurate: detection is call-SHAPED, but the assertion
compares files. A validator confirmed no other test in the suite catches it either, so
this is the sole mechanical enforcement of invariant #9.

The same canary also `continue`s past `lib/fresh-auth.ts` by path before scanning, so a
window-minting helper added there under a different name is unscanned, not merely
unmatched.

`backend/tests/routes/session-proof-invalidation.test.ts` has the identical defect:
it tests each WHOLE FILE for a sweep call over a NON-RECURSIVE `readdirSync` of
`src/routes`, so a second `sessions_invalidated_at` writer in `recover.ts` (which
already calls the sweep) passes, as does any writer under `src/lib` or a subdirectory.

Fix both to assert at occurrence / call-site granularity rather than container
granularity: scan upward from each match to the nearest enclosing function or route
handler and assert on `file#symbol` pairs. Make the invalidation canary's scan
recursive. Keep the planted-positive/negative self-tests; they are good and should be
extended to cover the new granularity.

**Add a behavioural backstop for AC 8.** It currently has zero dynamic coverage: the
only enforcement is the static scan above. Add a test asserting a login and a
signup-finalize response carry no `fresh_auth_proof`, so the invariant is not defended
by one regex alone.

### Item 3 — Bound the per-user session index

No `SREM` exists anywhere in the module, and `EXPIRE` re-arms the full cap on every
mint, so an account re-authenticating at least once per window keeps the key alive
indefinitely while members only accumulate. Past roughly 125k members
`redis.del(...tokens.map(...))` spreads every member into one call and throws
`RangeError` (verified empirically by a reviewer: 100k args succeed, 130k throw), so
the sweep BREAKS rather than degrades. Three independent changes:

1. `EXPIRE ... NX` so the index TTL is armed at creation, not pushed forward by every
   later mint.
2. Batch the sweep's delete into fixed-size chunks (500 is a defensible default) so a
   large index cannot blow the call stack.
3. `SREM` the token where a window is already known dead.

### Item 4 — Stop awaiting the slide persist on the broadcast critical path

`consumeSessionWindow` awaits `persistSessionSlide`'s Redis write before returning,
even though the authorization decision is already final and the write's failure path is
already fail-closed. With `commandTimeout: 5000`, a connected-but-stalled Redis adds up
to five seconds to every vote, comment, post, and review. Make the persist
fire-and-forget, keeping its existing catch.

A validator specifically cleared this as safe: `memStore.set` runs synchronously before
any await, so a racing concurrent read still observes the slid deadline, and any Redis
staleness can only SHORTEN the effective window, never lengthen it.

### Item 5 — Pin the literal window values

Every assertion in all three test files derives its expected bounds from the same
`SESSION_FRESH_AUTH_IDLE_SECONDS` / `SESSION_FRESH_AUTH_ABSOLUTE_SECONDS` constants the
production code defines, so changing `7200` to `72000` leaves the entire suite green.
ACs 2 and 3 state those numbers as literal requirements and nothing verifies them. Two
lines:

```ts
expect(SESSION_FRESH_AUTH_IDLE_SECONDS).toBe(15 * 60);
expect(SESSION_FRESH_AUTH_ABSOLUTE_SECONDS).toBe(2 * 60 * 60);
```

### Routed elsewhere, deliberately NOT in this round

- **Module split.** `fresh-auth.ts` at 1797 lines carrying two proof lifecycles, plus
  the `as number` casts in `persistSessionSlide` (provably sound today, a
  type-expressiveness gap). Both go to their own task so a structural split runs
  against a settled, green suite instead of mixing large-scale code movement into a
  diff that is already reworking the consume path.
- **Consent-op compensating DEL.** Pre-existing, so it does not gate this task, but a
  real single-use violation: the compensating delete is guarded on client existence on
  the stated assumption that ioredis flushes it on reconnect, and
  `maxRetriesPerRequest: 3` force-rejects queued commands after roughly two seconds.
  Its own task, which must also correct the convention entry that currently prescribes
  that guard shape.
- **Dropped by validation.** The cap-crossing loop test's ~14-minute resolution was
  raised and then rejected: sibling tests already bound the cap to single-digit seconds
  from both the issuance and consume sides, and the loop test does catch the risk the
  task named. No action.
- **Below threshold.** The thrice-repeated `Math.min` clamp, and the change whereby a
  malformed entry no longer self-burns (reason stabilises at `malformed` instead of
  degrading to `expired`; status unchanged). Recorded, no action.

### Architect follow-ups, tracked separately

The `[TODO Architect]` contract-docs sweep in this file is **deferred until this hold
block lands**. Item 1 changes the very wire behaviour those passages describe: "a
password reset ends every outstanding session proof" becomes a durable Postgres-backed
guarantee rather than a best-effort Redis sweep, and that is one of the passages the
sweep flags as needing the most careful rewording. Writing it now would document a
mechanism about to be replaced. The itemised survey in this file stays valid and will
be worked from, with the invalidation passages rewritten against the landed behaviour.

The stale `concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo`
entry and the new canary-granularity learning are architect-owned and in hand.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit
diff is the evidence and the architect updates the block at re-review.

---

## Backend re-review signal (2026-08-26)

Round-2 fixes landed in three commits on `main`:

- `0fad709d` — items 1, 2, 4, 5 (mechanism + canaries + behavioural AC 8 coverage).
- `84af4477` — item 3's coverage, held back one commit so the mutation probes below
  ran against a committed baseline.
- `22849bc5` — simplify pass: the two canaries' duplicate source walkers folded into
  the shared helper. Both granularity probes re-run and still kill.

Every claim below was verified by disabling the fix and confirming the test goes red,
not by reading the diff. The probe results are in the per-item notes.

### Item 1 — revocation epoch

`verifyHiveSignature` now publishes `req.hiveSessionsInvalidatedAt` (epoch ms, or
`null`) from the `sessions_invalidated_at` SELECT it was already running, and
`consumeSessionWindow` rejects any window whose `issued_at` is at or before it. The
epoch is threaded through `FreshAuthConsumeSurface`, so both session surfaces get it:
`consumeSessionFreshAuthToken` takes it as a third argument (passed by the custody
broadcast handler) and `consumeFreshAuthProof` reads it off the request (the
upload-token route). Consent-op surfaces leave it unset; a consent-op entry carries no
window to revoke.

`undefined` applies no cut-off. That is the no-app-pool case, where `verifyHiveSignature`
already skips its own JWT revocation check for the same reason — there is nothing to ask.

The two false docblocks are rewritten. `persistSessionSlide`'s now states that the `XX`
declined branch is reachable only on the Redis-served leg and converges the tiers there,
and names the epoch as what actually closes the sweep-versus-in-flight-consume race.
`invalidateSessionFreshAuthTokens`'s now says outright that it is the
storage-reclamation half and not the authoritative half, and enumerates the three ways
it is best-effort. The inline comment inside the `reply === null` branch and the
tier-ordering comment at the top of the sweep carry the same correction.

The swallowed index write is fixed alongside: `multi().exec()` resolves with a
`[err, reply]` tuple per queued command, so the surrounding catch never saw a
per-command failure and `fresh_auth.session_index_write_failed` was dead code for that
class. The replies are now inspected and the first per-command error is rethrown into
the existing catch. No new log was added; an existing one became reachable.

Coverage: `tests/routes/custody-non-consent-fresh-auth.test.ts` gains a
`revocation epoch` describe that drives the real route, real `verifyHiveSignature`, and
real Postgres. It stamps the column directly WITHOUT calling the sweep — reproducing
exactly the state the sweep leaves behind when it cannot do its job — and asserts the
broadcast is refused 401 `expired` while the proof is still fully present in the store.
The JWT is minted with an `iat` after the stamp so it survives, which is the realistic
shape: the user resets and logs back in, and what must not come back with the new
session is the window they had open before. A control asserts a window minted AFTER the
epoch still broadcasts, so a mutation that rejected on any non-null column value cannot
pass.

Probe: `if (false && ...)` on the epoch check turns the first test 200 (the vulnerable
behaviour) while the control stays green.

### Item 2 — canary granularity

New shared helper `tests/support/enclosing-symbol.ts` resolves a matched line to its
nearest enclosing function or route handler and returns `file#symbol` occurrence keys.
Resolution is textual by design (a canary that needs the compiler is a canary people
delete) and it carries its own planted positives/negatives, including the
wrapped-parameter-list case that a naive "closing paren ends the block" rule gets wrong.

Mint canary: assertion is now over `file#symbol`, expecting exactly
`routes/custody.ts#POST /session-auth` and `routes/orcid.ts#handleSessionAuth`. It scans
`lib/fresh-auth.ts` instead of skipping it by path — only the definition LINE is
skipped, and by shape. It also gains a second, name-independent scan: session-kind
entries are constructible only by writing the `kind: 'session'` discriminator, so the
enclosing symbols of that object-literal field are pinned to
`issueSessionFreshAuthToken` and `consumeSessionWindow`. That covers the case the
name-based scan structurally cannot — a window-minting helper added inside the module
under a different name.

Probe: adding `issueSessionFreshAuthToken(...)` to `handleLogin` in `routes/orcid.ts` —
the file's own docblock's most-likely scenario, and the case the file-set version stayed
green for — now fails, naming `routes/orcid.ts#handleLogin`.

Invalidation canary: the scan walks all of `src/` recursively instead of a flat
`readdirSync` of `src/routes`, and pairs each column WRITE with a sweep call in the SAME
enclosing symbol rather than testing whole file against whole file. A self-test on two
synthetic handlers pins that a write and a sweep in different functions of one file no
longer satisfy each other.

Probes, both previously green under the whole-file form: a second unswept
`sessions_invalidated_at` write inside `POST /recover/dispute` (a file that already
sweeps from two other handlers) now fails, and a writer planted in `src/lib` — outside
the old non-recursive scan entirely — now fails.

AC 8 behavioural backstop: new
`tests/routes/session-establishment-mints-no-window.test.ts` drives `POST /api/auth/login`
and `POST /api/auth/confirm` for real and asserts no proof-shaped field appears anywhere
in the response, at any depth, under any casing. A path-specific check on
`data.fresh_auth_proof` would pass for a proof handed back one level deeper or renamed,
so the detector is a deep walk with its own planted positives for five placements. The
ORCID `mode='login'` branch gets the same assertion in `tests/routes/orcid.test.ts`,
beside its `session_auth` sibling, since the two handlers sharing one dispatch is what
makes that regression look like a consistency fix. Both halves kill the `handleLogin`
mint probe above.

### Item 3 — bounded index

Three changes, each with a mutation-verified test in `tests/lib/fresh-auth.test.ts`:

- `EXPIRE ... NX` so the index TTL is armed at creation. Probe: dropping `NX` re-arms
  the full cap and the TTL test goes red. The cost of `NX` is that a window minted late
  in the key's life loses index membership when the key expires — acceptable only
  because item 1 moved the authoritative close off the index; noted in the code.
- The sweep deletes in fixed 500-member chunks. The test plants a real entry behind
  every one of 1201 members and counts survivors rather than spot-checking a few:
  `SMEMBERS` returns hash order, and a three-key spot check passed against a truncating
  sweep by luck on retry. That earlier version is what the probe caught. The current
  test leaves 701 survivors against a 500-truncated sweep.
- A window found dead at consume is `SREM`ed from the index (and dropped from both
  tiers) by a new `dropSessionWindow`. Fire-and-forget, deliberately unlogged: it runs
  on every consume of a closed window, which is an ordinary client condition. Probe:
  removing the `SREM` leaves the member behind and the test goes red.

### Item 4 — slide persist off the critical path

`void persistSessionSlide(...)`, keeping its existing catch. The in-memory write inside
it runs synchronously before the first await, so a concurrent read still observes the
slid deadline. The three existing slide-persistence tests (`XX` flag present, no
write-back on the memStore-served leg, declined write removes the in-memory copy) all
still pass unchanged — the `redis.set` call is issued synchronously, and the single
connection keeps the declined reply ordered ahead of the next consume's read.

### Item 5 — window values pinned

Two literal assertions in the `session-proof window` describe. Probe: `7200` -> `72000`
turns it red, where previously the entire suite stayed green.

### For the deferred contract sweep

One wire-visible change beyond what the sweep already lists: a session proof presented
after a password reset or recovery is now refused `401 FRESH_AUTH_REQUIRED` with
`reason: 'expired'` even when the Redis sweep never reached it. The passage the hold
flagged as needing the most careful rewording ("a password reset ends every outstanding
session proof") is now a durable Postgres-backed guarantee rather than a best-effort
one, and can be worded as such.

### Not in this round, unchanged from the hold's routing

The module split and the consent-op compensating `DEL` stay in their own task files. The
`persistSessionSlide` `as number` casts are untouched — they ride with the split, per
the hold.

### Suite state

`npx vitest run` (full backend, 15 min): **2496 passed, 20 failed across 8 files, 10
skipped.** Every one of the eight is accounted for and none is in a surface this task
touched:

- Seven are the standing pre-existing failures — `accreditation.test.ts` (the two
  broadcast-attempts-cap specs), `reviews.test.ts` (the two SQL-accreditation-gate
  specs), `idempotency-real-haf`, `papers-enrichment-parity-gate`,
  `accreditation-idempotency`, `profile-auth-bypass`,
  `cast-hardening-author-index-weight`. Confirmed by spec name, not by file name.
- One, `auth-concurrency.test.ts`, is the known load-induced class: its timing-oracle
  assertion saw a 429 instead of a 401 under full-suite concurrency. It passes in
  isolation, verified.

Everything this task touches passed in the full run: `tests/lib/fresh-auth*.test.ts`,
`tests/eslint/`, all `custody-*`, `session-*`, `settings-*-fresh-auth`, `orcid.test.ts`,
and `tests/middleware/`. `npm run typecheck` clean; `npm run lint` clean apart from one
pre-existing unrelated warning in `lib/author-supersession.ts`.

---

## Architect re-review (2026-08-31) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `ce5b7991..22849bc5` (backend paths only), pinned to
`22849bc5` because `e85d845c` from the consent-op task sits on top in the working tree.
Seven persona lenses completed plus architect direct verification.

**All five round-2 items landed and the architecture is sound.** Nothing below says a
fix is absent or wrong in design. Independently verified at the pinned head, not taken
from the completion signal: `EXPIRE ... NX`, the 500-member chunking, and the `SREM` in
`dropSessionWindow` are all present; `void persistSessionSlide(...)` genuinely removes
the await with no other write-await left on the consume path; both literal window pins
exist; the epoch reaches both session surfaces; and no new comment-anchor rot was
introduced.

Several concerns were actively checked and **cleared**, which matters as much as the
findings:

- `enclosingSymbol` fails CLOSED. An unresolvable line returns `MODULE_SCOPE` and
  becomes a new `file#<module>` key rather than being silently dropped. Verified by
  execution, including the shapes the resolver does not recognize.
- A Postgres failure on the epoch SELECT returns `503` with `retriable: true`. It does
  not continue with the field unset, so the auth surface does not degrade open.
- The epoch reuses the existing SELECT (no new query), `EXPIRE NX` folds into the
  existing `multi()` (no new round-trip), and `dropSessionWindow` is genuinely
  fire-and-forget. Performance returned zero findings.
- Account-state defense against 6.1/6.4/6.5, Redis key prefixing, the no-emdash rule,
  backend zone, and full test-mock carve-out compliance all came back clean.
- The `X-Hive-Signature` path legitimately has no epoch cut-off. A signature caller
  already holds the live posting key, so impact is nil. Now documented.

Ten items. The theme is enforcement, not behaviour: two of the five landed fixes have
no regression protection at all, and the canaries R2 hardened remain evadable in their
newly-written halves.

### Item 1 — R4 has zero regression protection

Nothing distinguishes fire-and-forget from awaited. No test uses a deferred promise, a
hanging mock, or `Promise.race`; the only timer in `fresh-auth.test.ts` is an unrelated
50ms sleep. Re-adding `await` before `persistSessionSlide` silently restores the full
stall on every vote, comment, post, review, and edit, and the suite stays green.

This also makes the round-2 signal's claim that every fix was verified by disabling it
and watching a test go red inaccurate for R4: no test can go red.

Mock `redis.set` to never resolve and assert the consume still resolves promptly.

### Item 2 — The revocation epoch is untested on the upload-token surface

`consumeFreshAuthProof` sets `sessionsInvalidatedAtMs` for the IPFS upload-token route,
but none of the six upload-token test files contains `sessions_invalidated_at`,
`hiveSessionsInvalidatedAt`, or the phrase "revocation epoch". Deleting that property
leaves the whole suite green. R1 is verified on one of its two surfaces.

Add a route-level test on `POST /api/ipfs/upload-token` mirroring the two `revocation
epoch` tests in `custody-non-consent-fresh-auth.test.ts`.

### Item 3 — The mint canary is defeated by an aliased import

`import { issueSessionFreshAuthToken as mint }` then `await mint(...)` evades both
scans: the call regex matches neither the import line nor the call site, and the
aliasing caller never writes the `kind: 'session'` discriminator, so the backstop stays
green too. This is the blind spot R2 was written to close.

Match the identifier rather than the call shape (keeping the definition-line skip), and
add an import-site assertion: the set of files importing the symbol must equal
`routes/custody.ts` and `routes/orcid.ts`.

### Item 4 — A commented-out sweep call satisfies the invalidation canary

The sweep scan is passed no `skipLine` predicate, while the sibling mint canary passes
`COMMENT_LINE_RE` to its own. A commented-out sweep call therefore registers as a real
occurrence and pairs with a live column write in the same enclosing symbol. Unlike item
3 this is an ordinary accident: commenting a call out while debugging and forgetting to
restore it.

Pass the comment filter to the sweep scan. Deliberately NOT to the write scan, where
over-matching is fail-closed.

### Item 5 — The epoch parameter is optional, so omission disables the cut-off

Both the third parameter and the surface field are declared with `?`. Omitting them
yields `undefined`, which the guard treats as no cut-off, silently disabling the
authoritative half of invalidation and leaving only the best-effort sweep. Not
reachable today, and nothing mechanical prevents a future surface from omitting it.

The hazard is not hypothetical: `expectWindowClosed` in
`session-proof-invalidation.test.ts` already calls the consume with two arguments, so
its three end-to-end tests exercise the sweep only and would stay green if the epoch
check were deleted outright. Its docblock claims it makes "the same call the broadcast
route makes"; the route passes a third argument, so that is a fourth false docblock.

Drop the `?` on both declarations. Runtime semantics are unchanged, omission becomes a
compile error, and that forces the test helper above to state its posture. Fix its
docblock in the same change.

### Item 6 — The `<=` boundary and the null/undefined semantics are unpinned

Both epoch tests take `Date.now()` after the mint or sleep first, so the
same-millisecond case is never exercised and mutating `<=` to `<` stays green. That
case is the realistic race, not an exotic one, and `auth.ts` writing
`sessions_invalidated_at = NOW()` (transaction-start time) widens it slightly.

Nothing asserts that both `null` and `undefined` mean no cut-off either, so a mutation
to `!= null`, or to a truthiness check that also mishandles epoch `0`, is invisible.

Plant an entry whose `issued_at` equals the epoch exactly and assert `expired`, plus
two cheap cases pinning `null` and `undefined`.

### Item 7 — The AC-8 backstop has a route gap and matches only by name

It covers login, signup-finalize, and ORCID `mode='login'`, but not
`POST /api/auth/session`, `/api/auth/recover`, or `/api/auth/recover/verify`, all three
of which reissue a JWT and all three of which the mint canary's own message names.
Composed with item 3, a mint can land on `/api/auth/session` with every guard green.

The detector also matches key names against a two-token pattern, so a proof returned as
`proof`, `reauth_token`, or `broadcast_token` passes untouched, and it inspects only the
JSON body, not headers or `Set-Cookie`. The claim that it covers any field "at any depth,
under any casing" is true for placement and casing but not for naming.

Separately, the ORCID login-mode assertion uses three exact-path checks instead of the
deep walk the other two surfaces get, leaving the surface most likely to drift with the
weakest check.

Match proof-shaped values as well as key names, assert over headers and cookies, extend
to the three uncovered routes, and reuse the deep-walk helper in the ORCID test.

### Item 8 — The 500-member chunk size is not pinned

The 1201-member test correctly pins that chunking loses no members, which is the right
shape and catches the truncating-sweep bug that an earlier spot-check version missed.
It does not pin the chunk size: raising the constant far above the member count leaves
it green.

Spy on `redis.del`, assert the call count equals `ceil(members / chunk)` and that no
call exceeds the chunk size.

### Item 9 — `issued_at` is synthesized, and its comment is now false

Round 2 promoted `issued_at` from informational metadata to the anchor of the revocation
comparison, but `validateStoredEntry` was not revisited. It still admits an entry whose
`issued_at` is missing or non-epoch and synthesizes one from the absolute deadline, so
the code invents the input to its own revocation decision. The comment still calls the
field informational.

No live bypass: reaching the fallback needs direct Redis write access. Two latent
fail-opens remain, though. The epoch-ms check accepts any finite positive absolute
deadline, so the synthesis is unbounded upward, and any future reduction of the cap
constant would make legacy entries reconstruct later than they were minted.

Reject a session entry whose `issued_at` is missing or non-epoch instead of synthesizing
one, and rewrite the comment to state that it is the revocation anchor, set at mint and
carried unchanged through every slide.

### Item 10 — Both canary regexes under-match

The discriminator pattern requires a trailing comma and single quotes, so a single-line
`{ kind: 'session' }` or a double-quoted spelling evades it. There is no prettier config
and no eslint quote or comma-dangle rule in `backend/` to force the matched style. This
is the one scan meant to be name-independent, and it is defeated by a quote character.

The revocation-write pattern misses several ordinary SQL spellings of the same write,
and under-matching there is fail-open: an unmatched write is never required to pair with
a sweep.

Relax the discriminator pattern and move the type-position exclusions into the skip
predicate rather than relying on the comma. Use the bare column name as the write
signal and allowlist the one known read site. Extend the planted negatives to cover the
bypass shapes in both.

### Architect follow-ups, discharged in this round

The deferred contract-docs sweep is **done**, landed at `bfdc3eb2`. Four passages
rewritten: the `custody.md` TBD placeholder, the 6.4.1 "useless without a live session"
bullet that stated the requirement as an unmet MUST, the 6.7 title and opening, and the
6.7 client-visible-effect paragraph. That also settles the 6.6 same-commit rule, which
the three round-2 commits did not honour for these sections. Nothing in this hold block
depends on it.

### Not in this round, unchanged from the round-2 routing

The module split, the consent-op compensating `DEL`, and the `as number` casts stay in
their own task files. The cap-crossing loop test runtime and the `Math.min` clamp remain
below threshold.

Note for the canary work in items 3, 4, 7 and 10: the round-2 fix **complied** with
`solutions/conventions/source-discipline-canaries-must-assert-at-call-site-not-file-granularity`,
which governs ASSERTION granularity. Every item above sits on the DETECTION axis, which
that entry explicitly scoped out ("a regex can match precisely at call shape and the
canary can still be blind"). The rule was followed; these are where it set its boundary.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit
diff is the evidence and the architect updates the block at re-review.

---

## Backend re-review signal (2026-08-31)

Round-3 fixes landed in two commits on `main`:

- `b9526720` — items 1 through 10.
- `129f5538` — one gap a mutation probe found in item 5's own fix, held back
  a commit so the probe ran against a committed baseline.

Before implementing, each of the ten findings was independently re-derived
against the tree rather than taken from the hold: all ten reproduce. Item 6 is
the one partial, and the correction is in its entry below. Every claim of
"killed" here was verified by disabling the landed fix and watching the named
test go red, then restoring; seventeen probes, all killed, listed per item.

### Item 1 — the detached slide persist

`tests/lib/fresh-auth.test.ts` gains one test that mocks `redis.set` to a
promise that never settles and races the consume against a sentinel timer. The
test pins TWO properties of the same two statements, because verification found
a second mutation of that pair with no coverage at all: moving the unconditional
`memStore.set` inside `persistSessionSlide` behind the network write. That is
the natural-looking "only refresh the backup once the canonical write is
confirmed" refactor, it falsifies the sentence `consumeSessionWindow`'s docblock
uses to justify the detachment, and under a slow Redis it closes every active
user's window at its mint-time idle deadline. So the test's second half drives a
consume past the mint-time deadline with `redis.get` rejected, which can only
succeed if the in-memory tier already carries the slide.

Probes: `await persistSessionSlide(...)` → red on the race. Deferring the
in-memory write behind the `await redis.set` → red on the second half.

Redis-gated by necessity, and the file says so: with no Redis
`persistSessionSlide` returns before its first await, so awaited and detached
are genuinely indistinguishable and no Redis-free variant of this pin exists.

### Item 2 — the epoch on the upload-token surface

New `tests/routes/ipfs-upload-token-revocation-epoch.test.ts`. Neither existing
home works: `ipfs-upload-token.test.ts` mocks both `verifyHiveSignature` and
`getAppPool`, so `req.hiveSessionsInvalidatedAt` is `undefined` on every request
there and no epoch can reach the route; the real-path signature file sends no
Authorization header, so the proof consume short-circuits before the gate.

The new file mocks NOTHING. Every request declares a structurally invalid
`file_sha256`, so it stops at the handler's shape check, which sits after
`requireFreshAuth` and before the accreditation HAF read. The 401-versus-400
discrimination is the whole assertion, which removes the HAF dependency and the
mock the accreditation gate would otherwise have needed.

Three specs: a pre-epoch window refused 401 `expired` while the proof is still
in the store, a post-epoch window reaching descriptor validation (the control
that stops a comparison rejecting on any non-null column), and an epoch stamped
at EXACTLY the window's `issued_at` after a first consume has slid it. That
third one carries the route-level half of item 6's boundary and additionally
pins that the slide does not rewrite the anchor.

Probes: deleting the epoch from the surface literal in `consumeFreshAuthProof` →
two red. Flipping `acceptSession` to false → three red.

### Item 3 — the aliased-import evasion

The mint scan matches the IDENTIFIER now, not the call shape, with a skip
predicate for the definition, comment lines, and unaliased import specifiers.
The specifier skip is VETOED by an `as` on the line, and that veto is the whole
mechanism: an alias becomes a module-scope occurrence, which is never an allowed
key. Two details are load-bearing and both were found by execution rather than
by reading: the closing-brace branch of the specifier pattern requires a
following `from`, or an object literal holding the reference is spared too; and
the veto cannot be folded into the specifier pattern, because duplicate
specifiers for one exported name are legal and the unaliased half would buy the
aliased half a skip.

Added alongside, per the hold: a file-granular import-site assertion, since a
module that imports the mint can call it under any local name. File-granular
deliberately, because an import always sits at module scope and the symbol half
of every key would be a constant.

Also added, because verification found the discriminator backstop does not cover
it: a scan pinning `persistSessionSlide`'s caller set. A helper that
spread-copies an already validated entry with a pushed-out deadline extends a
window while writing neither the mint's name nor the discriminator, and that
persister is the chokepoint it must reach.

Probes: an `issueSessionFreshAuthToken as mint` specifier plus a `mint(...)` call
in `handleLogin` → red, naming `routes/orcid.ts#<module>`. A window-extending
helper calling the persister under a new name → red.

### Item 4 — the commented-out sweep

`isCommentLine` and `isCommentedOut` are now exported from
`tests/support/enclosing-symbol.ts`, and `occurrencesOf`'s skip predicate
receives the line index and the file so a predicate can decide from context.
The sweep scan takes `isCommentedOut`, which also covers the block-comment
toggle: an editor toggling a multi-line selection prefixes only the first line,
so the dead call keeps its indentation and its `await` and reads as live code to
any predicate that judges a line by its own first characters.

The real fix is structural: the whole-tree assertion and every synthetic probe
now route through ONE `unsweptWriters` helper. A probe that rebuilt the scan
with its own arguments would stay green when the real scan lost its filter,
which is the regression the probes exist to catch and which the real tree cannot
show, since no writer is commented out today.

**Deviation from the hold, flagged deliberately.** The hold says to pass the
comment filter to the sweep scan and NOT to the write scan. The write scan does
now carry `isCommentLine`, and it has to: item 10 broadens the write signal to
the bare column name, which matches every docblock mention across the module,
the middleware, and two route files. Without the skip each mention becomes an
occurrence that must pair with a sweep in its own enclosing symbol and the suite
goes red on documentation alone. The hold's rationale still holds for everything
that is not a comment, and the docblock says so: prose cannot write a column.

Probes: dropping the filter → three red. Substituting the shape-only predicate
for the block-aware one → the block probe red, the line-comment probe still
green, which is exactly the mutant the narrower fix could not kill.

### Item 5 — the optional epoch

Both `?` dropped, typed `number | null | undefined`. `consumeFreshAuthToken`
writes `sessionsInvalidatedAtMs: undefined` explicitly with the reason.

The 38 two-argument test call sites are routed through one
`consumeSessionNoEpoch` helper rather than gaining 38 bare `undefined`s: the
finding's point is that the no-epoch posture must be STATED, and 38 bare
arguments state it zero times while one named helper with a docblock states it
once. The one call that does drive the cut-off calls the real function with
three arguments.

`expectWindowClosed` now passes `undefined` explicitly, and its docblock and the
suite header say why: withholding the epoch is what scopes those three
assertions to the SWEEP. Handing the real epoch in would make them pass for a
writer that stamped the column and never swept, which is the exact omission that
suite exists to catch. A matching `expectWindowOpen` replaces the four inline
open-window assertions.

A new canary, `tests/eslint/no-session-consume-without-revocation-epoch.test.ts`,
covers what the type cannot say: that the value passed is the request's epoch
and not a literal. It pairs each consume call with a `hiveSessionsInvalidatedAt`
reference in the same enclosing symbol.

Probes: restoring the `?` on the parameter → `typecheck:tests` red on the unused
`@ts-expect-error`. Substituting a literal `undefined` at the broadcast call
site → the new canary red.

A third probe SURVIVED and produced the second commit. `FreshAuthConsumeSurface`
is module-private, so making its field required only forces an in-module literal
to MENTION the field, and nothing outside `lib/fresh-auth.ts` can name the type
to pin its shape: restoring the `?` on the field and dropping it from the
consent-op literal left the whole suite green. The canary now pairs each
`consumeFreshAuthTokenForSurface` construction with a mention of the field in
the same symbol; re-probed, red.

### Item 6 — the boundary and the null semantics

Verified as PARTIALLY confirmed. The `<=` half is exactly as the hold describes
and is now pinned. The null/undefined half needs its rationale corrected, and
the correction matters because otherwise the next reviewer hunts for a kill that
does not exist: the mutations the hold names (`!= null`, a truthiness check
mishandling epoch 0) are NOT killable at this seam. `isEpochMs` forces
`issued_at > 0` whenever the cap is in the future, and with a past cap the next
deadline check returns the identical result through the same drop, so
`typeof x === 'number'`, `x != null` and a truthiness check agree on every
reachable input. TypeScript also forbids a non-number non-nullish at every call
site. The honest kill for an explicit `null` case is a null-SPECIFIC fail-closed
edit, and the general fail-closed inversion is already killed many times over by
the existing two-argument consumes. Both cases are kept on that basis.

Placed at unit level, where the consume takes the epoch as a direct argument, so
the test controls both sides of the comparison exactly. At route level the mint
reads its own clock and the epoch round-trips through Postgres, so an
exact-equality test there would be a flake; the route-level half of the boundary
rides on the upload-token spec above, which computes the anchor from the mint's
own reported cap instead of guessing it.

`plantSessionEntry` gains a defaulted `issuedAt` parameter, so the deadline
callers are untouched and the epoch cases decouple the anchor from both
deadlines. Five cases: same-millisecond, one-millisecond-after with the epoch
snapped to a whole second (without the snap the floor-to-seconds mutation
escapes one time in a thousand), explicit `null`, absent, and two verification
found uncovered — the drop of the rejected window from the tier that served it,
and that a slide leaves `issued_at` alone.

Probes: `<=` → `<` → red. A null-specific fail-closed edit → red. Deriving the
anchor from the cap → red.

### Item 7 — the AC-8 route gap and the name-only detector

The detector moves to `tests/support/session-proof-shape.ts` and gains a second,
independent tell: a value of exactly 64 hex characters, bounded on both sides by
a non-hex character and matched as a substring. That is what
`issueSessionFreshAuthToken` mints, the token IS the store key the consume looks
up, so a regression cannot re-encode it and still have a working client. The
substring form reaches a proof inside a `Set-Cookie` value or a redirect query
parameter. Verified non-colliding against the JWT these routes return beside it
(a period is non-hex, so a run cannot cross a segment boundary, and the
signature segment is 43 characters), against the 32-hex ORCID state, a 128-hex
digest, express's weak ETag, and helmet's CSP hash. The signup-binding cookie
emits the same shape and is not a broadcast credential, so its value is exempt
by cookie name while its name is still checked.

Headers and `Set-Cookie` are walked, and a cookie's own name is tested
explicitly, since it lives inside the header value.

Coverage: `POST /api/auth/session` on BOTH its branches (Bearer, which is the
branch that reads the revocation column, and a real Hive signature), the two
recovery routes in the invalidation suite where their fixtures already live, the
ORCID login branch switched from three exact-path checks to the deep walk, plus
the Keychain link and the custody upgrade in their own suites.

An inverted control runs the detector against the ONE licensed mint's real 200
and asserts it throws. Every other planted case is a hand-built literal, so
without it a helper that read a supertest response wrongly would report no
offenders for all of them and leave every no-proof assertion in the suite
vacuously green.

Closing the class rather than the instance: the mint canary now pins the set of
`jwt.sign` sites as a coverage registry. All eight have a wire-level assertion.
A new session-issuing route is a red bar that says "add the assertion, then pin
the site".

Probes: a `fresh_auth_proof` field on the token-refresh response → red. The same
grant renamed to `reauth_token` with a real 64-hex value, which the name tell
alone cannot see → red. A brand-new session-issuing route → the registry red.

### Item 8 — the chunk size

The 1202-member real-Redis test keeps its survivor count and gains a
pass-through `redis.del` spy asserting the exact width sequence
`[500, 500, 202, 1]` (three member batches plus the index key's own single-argument
delete). Widths are read out before `mockRestore()`, which clears recorded calls.

A second test pins the bound independently of any fixture size, because every
assertion in the first is a function of its member count: a sweep that batched
only ABOVE a threshold and kept a one-round-trip fast path below it passes all
of them while reinstating the unbounded spread for exactly the accounts the
batching protects. `smembers` is stubbed to a synthetic 200k index and `del` to
a no-op, so only the arithmetic runs and no Redis traffic is issued; the
real-path companion for the same risk class is the 1202-member test beside it.

Probes: widening the constant to 500000 → both red. A size-conditional unbounded
fast path → only the scale test red, which is the point of having it.

### Item 9 — the synthesized anchor

`validateStoredEntry` rejects a session entry whose `issued_at` is missing or
non-epoch instead of reconstructing it, and the three comments that called the
field informational now call it the revocation anchor. No behaviour change: the
field is a required stored member written at every issue and carried through
every slide, so nothing a deployed build produces reaches the reject, and the
reject surfaces as the same 401 a closed window already produces.

Three tests. Two prove a bad anchor is refused (missing, and a non-epoch value —
a presence-only guard passes the second). The third proves the SURVIVING anchor
is the stored one: a guard that rejects and then still hands the comparison the
cap-derived value passes both of the others. It plants a deliberately
cap-inconsistent entry, because every real mint sets the cap to the mint instant
plus the window, where the two readings coincide.

Probes: restoring the synthesis → two red. Keeping the guard but deriving the
returned anchor anyway → the third red.

### Item 10 — the under-matching patterns

The discriminator pattern accepts any quote style, an optional trailing comma,
and a quoted key. Type positions are removed per-OCCURRENCE rather than by a
whole-line skip, because a skip keyed on a utility-type name hides a
construction that merely shares the line with one, and a typed local declared
from a narrowed type is the natural way to write exactly that.

The revocation-write signal is the bare column name. The middleware's three read
lines are exempted by exact LINE, not by enclosing symbol: a symbol-wide
exemption would cover any write later added inside the middleware, and the
obvious guard against that is the same under-matching form this change abandons.
A staleness test asserts each exemption still matches exactly one line, so the
per-line anchor cannot rot silently. The synthetic-handler probe grows a
quoted-identifier write, a template-literal write wrapping before the `=`, and a
commented-out sweep, none of which the old signal saw correctly.

Probes: a construction written `kind: "session"` inside `lib/fresh-auth.ts` →
red (it was a silent pass before). Reverting the write signal to the
`column = value` form → red.

### Contract docs

Nothing wire-visible changed this round. The one behavioural edge is item 9: a
session entry whose stored `issued_at` is missing or malformed now reports 401
`malformed` rather than being admitted with a reconstructed anchor. It is
unreachable for anything the mint writes, needs direct store-write access to
produce, and both reasons are already-documented 401s, so no contract passage
turns false. The sweep landed at `bfdc3eb2` stays correct as written.

### Suite state

`npx vitest run` (full backend): **2526 passed, 20 failed across 8
files, 10 skipped.** Every one of the eight is accounted for and none is a
suite this task touches.

- Seven are the standing pre-existing failures, confirmed by spec name rather
  than by file name: `accreditation.test.ts` (the two broadcast-attempts-cap
  specs), `reviews.test.ts` (the two SQL-accreditation-gate specs),
  `idempotency-real-haf`, `papers-enrichment-parity-gate`,
  `accreditation-idempotency`, `profile-auth-bypass`,
  `cast-hardening-author-index-weight`.
- One, `signup-verify-activation-recovery.test.ts`, is the known load-induced
  class: its lock-wait-budget spec blew a 33-second budget under full-suite
  concurrency. It passes in isolation in under 8 seconds, verified.

Everything this task touches passed in the full run: `tests/lib/fresh-auth*`,
all of `tests/eslint/`, every `custody-*`, `session-*` and `ipfs-upload-token*`
file, `orcid.test.ts`, `signup-verify.test.ts`, the `settings-*` fresh-auth
suites, `accreditation-metadata-edit`, the two `admin-*` fresh-auth suites, and
`tests/middleware/`.

`npm run typecheck` (src + tests) clean. `npm run lint` clean apart from the one
pre-existing unrelated warning in `lib/author-supersession.ts`.

### Not in this round, unchanged from the hold's routing

The module split, the consent-op compensating `DEL`, and the `as number` casts
stay in their own task files. The cap-crossing loop test runtime and the
`Math.min` clamp remain below threshold.

### Residuals recorded, deliberately not chased

Named so they are not mistaken for coverage. The construction scan is
line-oriented, so a session entry assembled by spread or shorthand property is
outside its reach; widening the signal to a bare `kind,` would drag
`validateStoredEntry` into the allowlist and dilute the "exactly two
construction sites" claim, so it is an architect decision rather than a
unilateral one. The write-to-sweep pairing is by enclosing symbol, not control
flow, so a write on an early-return branch of a handler that sweeps further down
still pairs. A trailing comment on an otherwise-live code line is not stripped
before matching, in either canary, because a comment marker also occurs inside
string literals and truncating there would drop a real reference; such a line
matches and goes red, which is loud rather than silent. And the coverage
registry pins whole handlers, so a mint on a conditional branch of a covered
handler that no fixture enters is out of its reach.

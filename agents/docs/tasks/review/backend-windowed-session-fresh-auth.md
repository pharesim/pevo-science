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

**Pre-existing drift surfaced while surveying** (architect's call whether to fold in or file
separately): the `ipfs_upload` and `edit_accreditation_metadata` fresh-auth actions are live
in `backend/src/lib/fresh-auth.ts`, `routes/custody.ts`, and `routes/orcid.ts` but appear in
neither the custody `/fresh-auth` action enum and its `VALIDATION_ERROR` restatement nor the
orcid `/start` and `fresh_auth` response enums. `ipfs.md` actively instructs integrators to
pass `action='ipfs_upload'` to both endpoints, so an integrator following it today is passing
a value the other two contracts call invalid. The `ipfs.md` sentence that points at those
enums is being rewritten anyway, which makes this the natural moment to close the gap.

# Close open session windows on custody upgrade

**Owner:** backend
**Created:** 2026-08-31

Routed out of the architect review of `b9526720` (windowed session fresh-auth,
round 4). Pre-existing, on a route that task never touched.

## Why

`POST /api/custody/upgrade` moves an account from server-held custody to
self-custody: keys rotate, a new JWT is issued, and the server's encrypted copy
of the posting key is deleted. It writes no revocation epoch and runs no sweep,
so any session-kind proof outstanding at that moment stays live until its
absolute cap.

The three routes that do invalidate are the password reset and the two recovery
paths. Upgrade is the fourth route that materially changes an account's
authentication posture and the only one that does not.

Impact is bounded rather than severe, which is why this is its own task and not
a hold. After the upgrade the server cannot broadcast for the account at all,
and the broadcast route refuses non-light custody before it ever consumes a
proof. What survives is the ability to mint IPFS upload tokens against PEvO's
node with a credential issued under the previous custody model, for up to the
remainder of the window. That is resource abuse and a stale credential, not
account takeover.

It is also squarely within what the windowed-session work set out to guarantee:
invalidating a user's sessions must also invalidate their outstanding
session-kind proofs. Upgrade was simply never enumerated as a case of that.

## Scope

1. Stamp the revocation epoch and sweep the account's outstanding session proofs
   as part of the upgrade, in the same transaction boundary the other three
   routes use.
2. Decide whether upgrade should also invalidate the account's bearer JWTs. It
   already issues a new one, so the question is whether the old one should keep
   working; the reset and recovery routes both say no. Whichever way it goes,
   state the reason in the route.
3. Consider whether the revocation-write canary should enforce the inverse
   direction it currently does not. It requires every writer of the epoch to
   sweep, and never requires a route that rotates credentials to write the epoch,
   which is why this gap had no guard pointing at it. If a general rule is not
   expressible, pin the known set of credential-rotating routes explicitly.

## Acceptance criteria

1. A session window minted before an upgrade is refused afterwards, asserted at
   the route level rather than only at the library.
2. The refusal is the epoch check, not merely the Redis sweep. A test that
   withholds the sweep must still show the window closed.
3. The JWT question from scope item 2 is decided, implemented, and covered.
4. Whatever guard comes out of scope item 3 fails when the new invalidation is
   removed from the upgrade route.

## Notes

Found by probing the guards rather than the behaviour: the canary that enforces
"every epoch writer sweeps" is one-directional, so a route that should stamp and
does not is invisible to it. That asymmetry is the more general lesson and is
why scope item 3 is in this task rather than left implicit.

## Backend completion notes (2026-08-31)

Landed in commits `79b57f8d` and `b1c700e2`. Per scope item:

1. The upgrade handler stamps `sessions_invalidated_at` in the same UPDATE
   that nulls the encrypted keys and sets `upgraded_at` (the same
   single-statement boundary the reset and recovery writers use), then calls
   `invalidateSessionFreshAuthTokens` before the reissue.
2. Decided YES: prior bearer JWTs are invalidated, matching the reset and
   recovery posture; the reason is stated in the route. The epoch is computed
   in Node and embedded as the reissued JWT's `reissuedAt` claim so the
   middleware's identity match spares exactly the token the upgrade response
   hands back (the recover.ts mechanism, now shared); the middleware's
   exemption-scope comment was widened accordingly.
3. The inverse guard is a pinned set: `every credential-rotating route stamps
   the revocation epoch` in the invalidation suite names the reset, both
   recovery phases, and the upgrade, and requires each to touch the column;
   the existing pairing then forces the sweep, so one membership buys both
   halves. A general rule was weighed and rejected in place: "rotates
   credentials" has no greppable signal that excludes signup's initial
   `password_hash`/custody writes, and enumerating those exemptions would
   restate the pinned list as its inverse.

Acceptance criteria: (1) end-to-end in `custody-upgrade.test.ts` — a window
minted before the real POST /upgrade is refused after it; (2) the epoch-only
leg re-plants the swept window into the in-memory tier and shows the stored
epoch alone refuses it, with a no-epoch control proving the re-plant was
live; (3) the old JWT draws 401 SESSION_INVALIDATED, the reissued token
survives its same-second revocation (403 at the custody gate), and its
`reissuedAt` claim is compared byte-for-byte against the stored epoch; (4)
removing the stamp from the route was verified to fail the pinned-set guard,
and removing the sweep to fail the pairing guard, via mutation runs in
isolated worktrees.

**[TODO Architect]** Contract and architecture doc updates on archive:

- `agents/docs/api-contracts/custody.md`, POST /api/custody/upgrade: the
  endpoint now also invalidates every previously issued bearer JWT and every
  open session-proof window for the account; the returned token is the only
  surviving session. Worth a sentence in the endpoint prose (SPA-visible:
  other tabs and devices are signed out and see `SESSION_INVALIDATED`).
- `agents/docs/ARCHITECTURE.md` § 6.7 (and the § 6.4.1 phrasing that names
  "a password reset or recovery" as the session-revoking events): custody
  upgrade is the fourth writer of `sessions_invalidated_at`, and the
  middleware's `reissuedAt` same-second exemption now covers its reissue
  site alongside the two recover.ts ones.
- Possibly UI-relevant: the cross-tab sign-out behavior above may interact
  with the pending ui session-teardown work; routing that is the architect's
  call.

---

## Architect re-review (2026-09-01) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `79b57f8d` + `b1c700e2`, seven lenses plus an
independent validation pass. **All four acceptance criteria verified end to
end**, checked in the code rather than taken from the notes: the sweep leg is a
direct library consume that can only mean storage removal; the epoch-only leg
provably reads the re-planted in-memory entry with a live no-epoch control; the
403-vs-401 leg is deterministic (the reissued token passes either by identity
exemption or by iat ordering) and the byte-for-byte reissuedAt pin holds through
the TIMESTAMPTZ round-trip; both mutation directions were statically
re-verified. Seven constructed attacks (round-trip identity, mid-sequence
crash, exemption reuse across rotations, Redis-down skip, double-upgrade race,
in-flight broadcast, scanner blind spots) all held. Testing, reliability, and
project-standards returned zero findings.

One item holds the archive.

### 1. The middleware exemption comment contradicts its own widening

The comment block this diff widened to name "the two recover.ts handlers and
the custody upgrade" as spared reissue sites still ends with the un-widened
tail sentence "only the recover.ts reissue is spared here" — a
self-contradiction inside one security-critical comment. Fix is one line:
"only the revoke-and-reissue sites above are spared here."

### Architect-owned, at archive (not blocking the implementer)

The `[TODO Architect]` block above stands and will be executed when this task
archives: ARCHITECTURE.md § 6.7 (fourth stamper, third reissue site, "any
reissue writer") and the § 6.4.1 phrasing, plus the api-contracts/custody.md
endpoint prose, plus routing the cross-tab sign-out note to the ui track.

### Routed elsewhere

The review also surfaced a PRE-EXISTING divergence this task did not create
and does not widen: the upgrade UPDATE never writes `custody='self'`, leaving
`(custody='light', upgraded_at set)` rows that § 6.1 does not enumerate, and
the ORCID login mint reads the column raw where auth.ts derives from
`upgraded_at`. Filed as its own pending task
(`backend-custody-column-self-alignment`); not part of this hold.

---

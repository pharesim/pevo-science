# An upload's username mismatch after a cross-tab sign-in signs the new account out

**Owner:** ui
**Created:** 2026-10-01
**Priority:** normal

Routed out of the architect archive of the fresh-auth count-tally task (archived
2026-10-01). The implementer's last sweep reported it as behaviour outside that
comment-only task; an architect-side check against the code confirmed it, and the
user approved filing it.

## Why

`uploadFile` (`lib/ipfs-upload.js`) opens a subject teardown guard at entry and checks it
before each retry leg re-acquires, so a cross-tab subject change during an upload unwinds
with `UPLOAD_SUBJECT_CHANGED` instead of acting for the new account. The two mismatch
branches do not check it: on `isUsernameMismatch(err)` both the first-attempt catch and
`retryOnce`'s catch throw `tornDownSession()`, which calls `handleSessionInconsistency()`.
That function disconnects whenever the store is connected, and its own docblock says so:
"This gate does not protect a session established after the flight began; a detector
that finds the store connected always disconnects it."

A reachable sequence: account X starts an upload. `uploadFileToIpfs` (`api.js`) hashes the
file (`sha256File`) before `authenticatedRequest` reads the JWT for the pre-flight. While
the file hashes, the user signs in as Y in another tab. The storage event scrubs this tab
and adopts Y. The pre-flight then sends X's window proof with Y's JWT, and the backend
answers 403 `username_mismatch`. The upload leg tears down Y's session, which removes the
stored session and signs Y out in every tab, with "Session inconsistency detected".

The mismatch is the departed subject's, not a corrupted session belonging to Y. The
retry legs already treat a teardown that landed mid-upload as the departed subject's
business; the mismatch branches should too.

The broadcast and consent-op mismatch arms are also unguarded, but this sequence does not
reach them: signer.js reads the token before its first await, and the consent-op `run`
callbacks call the API directly. Check this before deciding whether they need the same
treatment; do not change them on symmetry alone.

## Scope

1. A `username_mismatch` surfacing on any upload leg after the guard reads torn-down must
   not end the session the tab now holds. It unwinds the way the retry legs' torn-down
   branch does (`guard.cancel()`, then the subject-change code).
2. A mismatch while the guard is NOT torn down keeps today's behaviour (tear the session
   down, `UPLOAD_SESSION_TORN_DOWN`).
3. Update the comments that describe the mismatch branches and
   `handleSessionInconsistency`'s new-session caveat so they match, without line
   numbers, slugs or round ordinals.
4. Pin both halves with unit tests: a mismatch after a teardown leaves the new session
   connected and resolves the subject-change code; a mismatch without a teardown still
   tears down. Use the real guard and the real window where the existing upload suites
   already do.

## Acceptance criteria

1. The sequence in "Why" no longer disconnects the new account; the user sees the
   subject-change outcome, once.
2. A same-subject mismatch still tears the session down exactly as before.
3. Both halves are pinned by tests that fail if the torn-down check is removed.
4. Full frontend unit suite green; `npm run build` clean.

## Notes

`ui-session-inconsistency-report-idempotency` (in review at filing) changes how a second
detector behaves once the store is already disconnected. This task covers a different
case, a store connected as a different subject, and should compose with whichever way
that task lands. Check the state of `handleSessionInconsistency` on main before starting.

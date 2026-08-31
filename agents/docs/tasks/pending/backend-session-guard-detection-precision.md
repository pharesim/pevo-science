# Close the detection gaps in the session-proof guards

**Owner:** backend
**Created:** 2026-08-31

Routed out of the architect review of `b9526720` (windowed session fresh-auth,
round 4), which archived clean on its own acceptance criteria. The production
code is correct; these are holes in the machinery that keeps it correct. One of
them the implementer disclosed and explicitly deferred to the architect, and
this task is that decision resolved: close it, and accept the allowlist cost.

## Why

Invariant #9 (only `POST /api/custody/session-auth` and
`POST /api/orcid/callback mode='session_auth'` may open a session window) and
the revocation-epoch discipline are enforced by canaries under
`backend/tests/eslint/` plus a small number of pinned caller sets. Those guards
have now been probed by execution twice, in successive reviews, and each time
the same class of hole turned up: the guards assert on the right unit but their
detection misses shapes an ordinary developer could write.

Every item below was reproduced by replaying the canaries' own scan logic
against mutated copies of `backend/src`, with the baseline confirmed to
reproduce the expected sets first, so a green run on a mutant is a real evasion
rather than a harness artifact.

## Scope

### 1. The construction scan is line-oriented

The session-entry discriminator match requires the key and its value on one
line, so a wrapped literal (`kind:` on one line, the value on the next) and a
bare shorthand property both evade it entirely. This is the backstop for a mint
that does not call the licensed function, so evading it evades the last line of
defence.

Make the scan multi-line, or match a bare key signal, and accept that this adds
`validateStoredEntry` as a third allowlist member. The "exactly two construction
sites" claim is worth less than a scan that cannot be stepped around, and the
allowlist entry is visible where the current blind spot is not.

An alternative worth weighing if the allowlist growth is unwelcome: route both
writers through one entry factory that is the only place the discriminator
appears as a literal, and pin that factory's caller set the way the slide
persister's is pinned.

### 2. The pairing canaries can satisfy themselves at module scope

`enclosingSymbol` fails closed for a set-equality assertion: an unresolvable
line yields a module-scope key, which is never an allowed member, so the bar
goes red. That property does not transfer to a pairing assertion. When both
sides of a pairing resolve to the same module-scope key they satisfy each other,
so a declaration shape the resolver does not parse passes green.

Exclude module-scope keys from the satisfying sets on both pairing canaries, and
assert explicitly that no occurrence resolved to module scope. Plant a probe
using a declaration shape the resolver does not currently recognize, since the
existing self-tests pin regexes against single lines and cannot surface a
vacuity that lives in the key sets.

While in there, scope the support module's "never a silent pass" docblock claim
to set-equality assertions, and state the rule pairing scans must follow.

### 3. The surface seam pins the field's name, not its value

Dropping the optional marker forces a consume surface to mention the epoch
field, and the follow-up canary pairs each surface construction with a mention
of it. Neither requires the value to be the request's epoch, so a surface
written with a literal `undefined` alongside `acceptSession: true` passes both
seams and the compiler while silently disabling the authoritative half of
revocation.

Require that a surface opting into session acceptance also references the
request's epoch in the same symbol.

### 4. Storage writes bypass every caller pin

The slide persister's caller set is pinned, which covers extending a window
through the sanctioned path. A direct write to the entry store reaches the same
outcome without touching it, and the test-only in-memory seeding hook exported
from the module is a second such path with no pin at all.

Widen the chokepoint from the persister to the storage writes themselves, and
pin the seeding hook's caller set to its own definition, so it cannot acquire a
production caller unnoticed.

### 5. Comment handling on the sweep scan is directionally wrong

The scan skips full-line and block-toggled comments but not a sweep call sitting
in a trailing comment on an otherwise-live line, so a dead call still satisfies
a live write's pairing requirement. The reasoning recorded against this (that an
over-match goes red, which is loud rather than silent) holds for the mint canary
and inverts for the sweep canary, where an over-match is what makes the pairing
pass.

Strip a trailing comment for the sweep scan specifically, and plant the shape.
Leave the mint canary as it is, where the current direction is correct.

### 6. Smaller gaps found alongside

- The sweep scan has no definition-line skip, so the sweep function satisfies
  itself. Every sibling scan has one.
- The alias veto is applied per line, so an import statement wrapped across
  lines escapes it. Apply it to the joined statement; the occurrence helper
  already passes the surrounding lines.
- The session-issuing-site registry keys on a literal call shape, so extracting
  the mint into a helper collapses the list to one member and reads as ordinary
  maintenance. Match the helper too, and assert the list cannot shrink.

### 7. The revocation epoch is untested on the in-memory leg

Every epoch specification reads through Redis. Scoping the check to
Redis-served reads leaves the whole suite green, while in production that
mutation un-revokes every window the in-memory tier answers for during a Redis
outage, which is the exact condition that tier exists to serve.

Add coverage driving the consume against an entry served from the in-memory
tier with the epoch set.

## Acceptance criteria

1. Each numbered item above has a planted probe that fails before the fix and
   passes after it, exercising the evasion shape rather than a nearby one.
2. No pairing canary can be satisfied by a module-scope key on both sides.
3. A consume surface accepting session proofs cannot pass with a literal
   non-epoch value.
4. The whole-tree scans still pass against the current tree with no behavioural
   change to `backend/src`.
5. Every scan that grew an allowlist member names why that member is legitimate.

## Notes

Scope discipline matters here: this task hardens detection, and it is not
licence to restructure the guards or the module they guard. The structural split
of `fresh-auth.ts` is a separate task, currently blocked.

`agents/docs/solutions/conventions/source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md`
governs assertion granularity and was correctly followed; every item here sits on
the detection axis that entry explicitly scoped out. A companion entry for the
detection-precision class is worth writing once this lands.

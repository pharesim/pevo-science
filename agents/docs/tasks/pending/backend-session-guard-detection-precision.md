# Close the detection gaps in the session-proof guards

**Owner:** backend
**Created:** 2026-08-31
**Priority:** low

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

## Backend completion notes (2026-08-31)

Landed in commit `e56973c3` (canary hardening, all seven items) with a
follow-on resolver fix inside the same commit. Per-item mapping:

1. Construction scan: a key-anchored signal (`SESSION_KIND_BARE_KEY_RE`) now
   fires on wrapped literals and bare shorthand alongside the value-anchored
   form; `validateStoredEntry` is the third allowlist member, with its
   legitimacy argued in place (it echoes a stored kind whose writers the new
   storage pins cover). The factory alternative was not taken: it would have
   changed `backend/src`, which acceptance criterion 4 forbids.
2. Both pairing assertions in the epoch canary exclude module-scope keys from
   their satisfying sets and assert primary-side module-scope emptiness; the
   sweep canary's satisfying set is filtered the same way. The support module
   docblock now scopes the fail-closed claim to set-equality assertions and
   states the pairing rule; `isModuleScopeKey` is exported for reuse. Probes
   use the object-method-shorthand shape the resolver cannot parse.
3. A third seam in the epoch canary classifies each session-accepting surface
   symbol's epoch-field VALUE: shorthand pass-through or a
   `hiveSessionsInvalidatedAt` reference passes, any literal
   (`undefined`/`null`/number/string) is an offender; wrapped values are
   joined before classification so the new seam does not inherit the
   line-orientation hole item 1 closed.
4. Storage writes pinned four ways: every `memStore` toucher and every
   `KEY_PREFIX` toucher in the module (identifier-anchored, because the Redis
   writes are multi-line calls a write-shaped line pattern cannot see), the
   `fresh_auth:token` namespace literal across the whole tree, and the
   seeding hook pinned to zero production callers.
5. The sweep scan strips trailing line and inline-block comments before a
   line can satisfy a pairing; the mint canary keeps its direction. The
   accepted string-literal naivety is documented and fails closed.
6. Definition-line skip added to the sweep scan; the mint canary's alias veto
   runs against the joined import statement; the JWT registry attributes
   transitively to a fixpoint (`POST /callback` joins as `handleLogin`'s
   dispatcher) and carries a member-count floor.
7. **Premise did not reproduce.** Both tier-scoping mutations of the epoch
   check were already caught by existing tests before this task: scoping the
   check to Redis-served reads (`!fromMemStore &&`) fails four epoch specs in
   `tests/lib/fresh-auth.test.ts` (they plant via the in-memory hook, so they
   are served by the in-memory tier); the mirror scoping fails the per-user
   index test and a `custody-non-consent-fresh-auth` route spec. The
   in-memory-leg coverage was however incidental (it rides on planted tokens
   being absent from Redis), so the explicit forced-outage test the item asks
   for was added anyway: it drives the consume through a throwing Redis read
   and pins the cut-off on the fallback leg structurally.

Verification: every evasion shape above was replayed as a real mutation
against the committed tree in isolated worktrees, with the expectation that
the hardened guard goes red; a resolver improvement (parenthesized
expressions no longer read as function declarations) fell out of the
whole-tree run and is pinned by its own probes.

The suggested `/ce-compound` companion entry for the detection-precision
class is noted; deferred to the architect's judgment at review since the
convention store is architect-maintained.

`agents/docs/solutions/conventions/source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md`
governs assertion granularity and was correctly followed; every item here sits on
the detection axis that entry explicitly scoped out. A companion entry for the
detection-precision class is worth writing once this lands.

---

## Architect re-review (2026-09-01) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `e56973c3`, six lenses plus an independent
validation pass. **All seven scoped items verified genuinely landed**: every
planted probe discriminates its evasion shape (traced against real production
shapes, including validateStoredEntry's actual casts and shorthand returns),
AC4 holds by execution (all scan files green against the tree, zero
backend/src changes), comment-anchor and carve-out compliance is clean, and
the canary-ladder convention entries were followed — the fail-closed pairing
prescription essentially verbatim.

Six items hold the archive. Every one is an evasion of the HARDENED seams,
mechanically replicated twice — once by the finding reviewer and again,
independently, by the validation pass — and every one is an ordinary
authoring shape, which is this task's own bar. Same class, one layer deeper.

### 1. Trailing comments satisfy all three consume-canary seams

The satisfying sides of the required-mention seams count mentions inside
trailing comments on live lines (only full-line comments are filtered):
`consumeSessionFreshAuthToken(token, user, undefined); // TODO wire
req.hiveSessionsInvalidatedAt` passes the epochs scan green, and
`sessionsInvalidatedAtMs: undefined, // was req.hiveSessionsInvalidatedAt`
beside `acceptSession: true` classifies as epoch-referencing in the value
seam. This commit gave the sibling sweep scan `stripTrailingComment` for
exactly this dead-mention class; the consume canary's satisfying sides did
not get it. Fix: hoist `stripTrailingComment` into the support module and
apply it on every REQUIRED-mention satisfying side (the epochs scan, the
fields scan, and the value text before both classifier arms — the
string-truncation naivety fails closed on all three), with a
trailing-comment planted probe per seam.

### 2. Extracting the surface literal into a builder defeats the value seam

Facts are collected tree-wide but the offender loop judges only symbols that
CALL the surface consume. The ordinary helper-extraction refactor — a builder
returning `{ acceptSession: true, sessionsInvalidatedAtMs: undefined }`, a
wrapper calling the consume with the built object — passes all three seams
green while disabling revocation. It is the identical maintenance edit this
same commit hardened the JWT registry against. Fix: judge every
lib/fresh-auth.ts symbol whose facts are accepting AND (literal OR no epoch
ref), independent of surface calls — sound because the surface type is
module-private, and the one outside opts-bag writer (routes/ipfs.ts) stays
exempt. Add the builder shape as a planted probe.

### 3. Shorthand or quoted acceptSession evades the accepting classification

`ACCEPT_SESSION_WRITE_RE` requires a colon, so a shorthand forward
(`acceptSession,`) or quoted key never marks a surface accepting; beside
`sessionsInvalidatedAtMs: undefined` the surface passes. Three reviewers
found this independently — it is the same shorthand class this diff closed
for the sibling keys, unapplied to this key. Fix: mirror
`SURFACE_FIELD_WRITE_RE`'s key-position discipline and treat a shorthand
write (null value text) as ACCEPTING — the conservative direction the seam
already commits to; the option-bag `acceptSession?: boolean` negative stays
excluded. Planted probes both ways; no shorthand acceptSession exists under
src today, so no current red bar.

### 4. A kind key with an identifier value evades the composed discriminator

`kind: entryKind` (with `const entryKind = 'session'` nearby) matches neither
the value-anchored signal nor the bare-key signal (a colon followed by a value
is not end-of-line), so it contributes an empty occurrence set inside the
storage-pin-licensed symbols — and the new docblock's residual claim ("what
remains out of reach is an entry assembled entirely by spread") is therefore
inaccurate. Fix both: add a lowercase-identifier-value arm (another loud
false-positive class, matching the loud-FP posture the scan already takes)
and correct the residual docblock to state the surviving gap honestly.

### 5. The JWT registry seeds only the jwt.sign spelling

A route importing jsonwebtoken any other way (destructured, renamed,
namespace) mints session JWTs while seeding zero registry members; the
exact-set assertion and the member-count floor guard shrinkage, not silent
non-growth. All eight current importers use the default-import convention;
nothing pins it. Fix: a tree-wide occurrence scan over jsonwebtoken whose
only allowed shape is the default import — the same move this file already
makes for the session-mint function itself.

### 6. The validateStoredEntry allowlist license is wider than its argument

The new allowlist member licenses the WHOLE symbol, but its stated
justification covers only shorthand kind echoes. A value-anchored
`kind: 'session'` literal inside validateStoredEntry — a read-path kind
coercion one edit away from its existing defaulting arm, invisible to the
storage pins because it writes nothing — is now silently absorbed where the
pre-diff two-member allowlist went red. Fix: split the license by signal
strength — the value-anchored scan pinned to exactly the two constructor
sites, the composed key-anchored scan against the three-member list — plus a
planted probe with a value literal inside a validateStoredEntry-named symbol.

### Noted, not held

- Item 4 of the original scope (the four storage-write pins) was verified in
  aggregate only; no dedicated per-pin planted probe exists. Fail-closed
  set-equality shape mitigates. Adding one probe per pin alongside the fixes
  above is welcome but not required.
- Residuals judged below the ordinary-authoring bar, recorded for the next
  probing pass: a sweep-call shape inside a live string literal still
  satisfies pairing; the consume-epoch pairing is call-shaped (first-class
  function passing escapes it); wildcard SCAN access bypasses the contiguous
  keyspace literal; .mts/.cts under src would be invisible to every canary
  (none exists; pre-existing tree-walk boundary).

### Architect-owned follow-up

Once these land, the ordinary-authoring-shapes convention entry should be
refreshed to add the comment-tail-satisfying-side, builder-extraction, and
identifier-value shapes to its documented class. Architect runs
`/ce-compound-refresh`; do not hand-edit.

---

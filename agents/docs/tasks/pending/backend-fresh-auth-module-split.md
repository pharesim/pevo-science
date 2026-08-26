# Split fresh-auth.ts along the proof-kind boundary

**Owner:** backend
**Created:** 2026-08-26

## Why

`backend/src/lib/fresh-auth.ts` is 1797 lines, up from 1504 before the windowed-session
work, and now carries two complete proof lifecycles in one module: the consent-op kind
(single-use, target-bound, 5-minute TTL, burned before the action) and the session kind
(windowed, multi-use, sliding idle deadline under an absolute cap). A reader who needs
to touch one lifecycle has to load the whole file's mental model, including the other
lifecycle's burn path, credit-op target derivation, and the per-action target-binding
helpers, to navigate.

The unification of the two consume paths behind `consumeFreshAuthTokenForSurface` was
genuinely good: a code reviewer confirmed it replaced two near-duplicate ~140-line
locked functions with one shared implementation, so this is not a request to undo it.
The problem is only that the module now hosts two lifecycles' worth of surface area.

**Sequencing: do NOT start this until `backend-windowed-session-fresh-auth` has landed
its held fixes and is archived.** A structural split is safest against a settled, green
suite. That task is currently reworking the consume path (a revocation-epoch check, the
slide persist, the per-user index), and mixing large-scale code movement into that diff
would make both changes harder to review.

## Scope

### 1. Split along the kind boundary the module's own header comment already describes

Suggested shape, from the review; adjust if the code argues otherwise once you are in it:

- `fresh-auth-store.ts` — the shared core: `StoredEntry`, `readFreshAuthEntry`,
  `validateStoredEntry`, the in-memory tier, the key prefix, `isEpochMs`,
  `isValidTargetHash`.
- `fresh-auth-session.ts` — session mint, consume, slide, persist, invalidate.
- `fresh-auth.ts` — consent-op mint and burn, re-exporting the session surface so route
  imports are unaffected.

Route imports should not need to change. If they do, that is a signal the boundary is
in the wrong place.

### 2. Give the session entry a type that expresses its invariant

`persistSessionSlide` takes `entry: StoredEntry`, whose `idle_expires_at` and
`absolute_expires_at` are optional because consent-op entries lack them, then uses
`as number` casts on both to silence the optionality. The casts are provably sound
today: the sole caller builds from an already-narrowed
`Extract<ValidatedEntry, { kind: 'session' }>` where both fields are required, and then
discards that guarantee via a widening `: StoredEntry` annotation before passing it in.

Define a narrow session-entry type with both deadlines required, use it for the slid
entry and for `persistSessionSlide`'s parameter, and drop both casts. The new module
boundary is the natural place for that type to live, which is why this rides along with
the split rather than being patched separately.

## Acceptance criteria

1. No behavioural change. The full backend suite passes unchanged, with no test edits
   beyond import paths.
2. Route files' imports are unchanged, or the deviation is explained.
3. Both `as number` casts in the slide-persist path are gone, replaced by a type that
   requires both deadlines.
4. Each resulting module's header explains which lifecycle it owns and what the other
   one is, so the split is navigable rather than merely smaller.

## Notes

Both items came out of the `/ce-code-review` pass on `51ecba19`. The cast finding was
independently validated as a type-expressiveness gap rather than a live NaN or
TTL-corruption risk, so there is no urgency to it beyond doing it while the types are
already being moved.

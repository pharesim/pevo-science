# BACKEND-PROFILE-REVIEWS-ACCRED-GATE-CANARY-STALE-PARAM-SLOTS — accred-gate param-position canary went tautological after the reviews CTE grew to 7 params

**Owner:** backend
**Created:** 2026-06-09 (architect, surfaced by `/ce-code-review` of the buildWith-adoption review group; collateral, not introduced by that task)
**Priority:** P2 (a security-adjacent param-position pin no longer fires red on a mis-bind; no current defect — the runtime binds are correct today)

## Problem

`backend/tests/routes/profile-reviews-accred-gate.test.ts` pins the resolved `$N` param positions for the `/api/profile/:username/reviews` count/data SELECTs so a positional mis-bind of the username / anon-account params fails red. The pin captures the author-side and anon-side param values at fixed 0-indexed slots (`params[3]` = username, `params[5]` = anonAccount, per the header slot-map comment `$1..$3 = accred CTE params, $4 = username, $6 = anonAccount`) and asserts each is a string (`expect(t).toBe('string')`).

That slot map was correct when `fetchUserReviewsFromHaf` built its WITH block from `activeAccreditationsCteBody` alone (2 CTE params, username at `$4` / `params[3]`). The reviews handler now composes a second builder — `buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { claimer: username }))` — so the WITH block emits **7** CTE params (`$1..$7`), pushing username to `$8` (`params[7]`) and the anon-account param further out. The asserted slots `params[3]`/`params[5]` now land on `authorshipClaimsCteBody`'s own appTag/bridge params, which are ALSO strings — so the `toBe('string')` assertion passes unconditionally and would stay green even if username were mis-bound. The canary the param-counter comment in `profile.ts` cites as its red-on-mis-bind backstop no longer guards the current call-site shape.

The runtime binds are correct today (the handler drives every `$N` off the adaptive `paramIdx = accredCte.nextIdx` counter, not hardcoded positions), so this is a coverage hole, not a live defect.

## Goal

Restore the canary so a username / anon-account positional mis-bind fails red against the CURRENT 7-CTE-param call-site shape:

1. Recompute the asserted slot positions from the actual CTE param count — preferably DERIVE them (e.g. from the length of `buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { claimer })).params`) rather than rehardcoding new literals, so the next CTE-shape change can't silently re-stale the pin.
2. Update the header slot-map comment to match (anchor on the builder composition, not a frozen `$N` table).
3. Confirm the assertion actually goes red on a deliberate username / anon mis-bind (mutate a bind locally and watch it fail), so the pin is verified, not just relocated.

## Acceptance

- The param-position assertions read the username / anon slots at their CURRENT resolved positions and fail red on a positional mis-bind (verified by a local mutation check).
- Slot positions are derived from the CTE param count where practical, not rehardcoded literals.
- The header slot-map comment matches the current `buildWith(1, activeAccreditationsCteBody, authorshipClaimsCteBody{claimer})` composition; anchored on the builder composition (no line-number / slug / SHA anchors per root `CLAUDE.md` "Comment anchors").
- `npm run typecheck` + `npm run lint` clean; the test green.

## References

- `backend/tests/routes/profile-reviews-accred-gate.test.ts` — the stale param-slot assertions + header slot-map.
- `backend/src/routes/profile.ts` — `fetchUserReviewsFromHaf`, the `buildWith(1, activeAccreditationsCteBody, authorshipClaimsCteBody{claimer})` call + the adaptive `paramIdx = accredCte.nextIdx` counter the canary backstops.
- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — the convention this canary implements.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend completion note (2026-06-09)

Restored the param-position canary in `profile-reviews-accred-gate.test.ts` against the current 7-CTE-param call-site shape:

1. **Derived slots.** Added `USERNAME_SLOT`/`ANON_SLOT` computed from the LIVE builder param count — `buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { claimer })).params.length` — so the username slot is `accredCte.params.length` (0-indexed) and the anon slot is `+2`. No rehardcoded literals; a future CTE-shape change shifts the pin in step. The prior fixed `params[3]`/`params[5]` had gone tautological when the reviews CTE grew from 2 to 7 params.
2. **Value pins, not typeof.** The canary now VALUE-pins the slots (`params[USERNAME_SLOT] === '<requested username>'`, `params[ANON_SLOT] === config.hiveAnonAccount || ''`) instead of the previously-tautological `toBe('string')` (which passed on the wrong slot because `authorshipClaimsCteBody`'s appTag/bridge params are also strings).
3. **Header slot-map comment** rewritten to anchor on the `buildWith(1, activeAccreditationsCteBody, authorshipClaimsCteBody{claimer})` composition (no frozen `$N` table; no round/hold ordinals).

Verified non-vacuous: a deliberate local mis-bind (swapping `username` and `config.appTag` in `fetchUserReviewsFromHaf`'s `baseParams`) turned the value pin RED (params[7] held the appTag, not the username); reverted after confirming. `npm run typecheck` + `npm run lint` clean (lone pre-existing `author-supersession.ts` warning untouched); the test green (3 passed).

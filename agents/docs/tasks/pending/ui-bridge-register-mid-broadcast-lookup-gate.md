# UI-BRIDGE-REGISTER-MID-BROADCAST-LOOKUP-GATE — gate Lookup interactions while a Register broadcast is in flight

**Owner:** UI Agent
**Created:** 2026-05-20 (architect, surfaced by adversarial reviewer during `/ce-code-review` of `ui-bridge-register-lock-held-ux` round-2 commit `3062f827`)
**Priority:** P2 (UX regression)

## Problem

The bridge-register page lets the user run a `handleLookup` (identifier lookup + accreditation check) while a `handleRegister` chain broadcast is in flight. The defect is a UX state-leak with a divergence between visible UI and on-chain outcome:

1. User enters identifier A, clicks Register. `handleRegister` captures `identifier = this.identifier.trim()` at entry (correct: the snapshot is preserved before any await). `step` transitions to `'registering'`; broadcast in flight.
2. Mid-broadcast (during the chain-write wall-time, typically seconds), the user types identifier B in the input field and clicks Lookup.
3. `handleLookup` entry resets `step = 'idle'`, `errorMessage = ''`, `duplicateExisting = null` per `ui-bridge-register-lock-held-ux` round-1 hold item 1 (the state-reset hygiene fix). This masks `step === 'registering'` from the visible UI.
4. Lookup resolves. Paper B's preview renders normally.
5. Original Register for A resolves successfully. `step = 'success'`. 3s redirect timer fires. User is redirected to **paper A** while the visible UI shows paper B's preview.

The on-chain broadcast itself is correct (A was registered, A's payload was captured at the snapshot point). The defect is in the user's mental model vs the UI: they believe they were preparing or registering paper B, they end up on paper A's page.

Pre-existing race shape; round-2 of `ui-bridge-register-lock-held-ux` increased the visibility window. Pre-round-2, the `step === 'registering'` state would have remained visible at the byline area while the user typed identifier B; post-round-2, the state is masked the moment the user clicks Lookup.

## Goal

Prevent the user from initiating a Lookup while a Register broadcast is in flight. Two viable shapes — implementer discretion:

**(a) Template gate.** Disable the Lookup button (and ideally the identifier input field) while `step === 'registering'`. Mirrors the existing `:disabled="lookingUp"` pattern on the same controls. One-line change at each template gate site.

**(b) Handler-side identity guard.** Capture `const capturedIdentifier = this.identifier.trim()` at `handleLookup` entry; after each `await`, bail if `this.identifier.trim() !== capturedIdentifier`. Mirrors the post-await paper-identity guard pattern used in `paper-detail.js` `loadPaper()`. Doesn't prevent the click but no-ops the lookup when the user has navigated away.

Shape (a) is simpler and matches the existing UI affordance convention. Shape (b) is more defensive and survives programmatic re-entry that bypasses the UI gate. Either is acceptable.

## Acceptance

1. **Pick one of the two shapes** above. Shape (a) is the recommended default.

2. **Verify the visible affordance.** If shape (a), the Lookup button shows a disabled visual state during `step === 'registering'` consistent with the existing `:disabled="lookingUp"` styling. The identifier input also disabled so the user cannot type a new value AND attempt to register on it.

3. **No new behavior on the happy path.** A user who runs `handleLookup`, then clicks Register, then waits for the broadcast to resolve must see no change in behavior. The gate only fires when a Lookup is attempted DURING `step === 'registering'`.

4. **Test.** A vitest case driving the canonical race: drive `handleRegister` to the in-flight state (mock `registerBridgePaper` with a never-resolving promise OR use the existing fake-timers infra to halt mid-await), change `comp.identifier` to a different value, attempt `handleLookup`, assert either (a) the lookup did NOT fire (`mockFetchBridgeLookup` not called) for shape (a), or (b) `comp.lookup` did NOT update for shape (b). Resolve the original broadcast and verify the success path lands correctly.

## Out of scope

- Changing the broadcast capture snapshot in `handleRegister` (already correct; the snapshot is the right defense for the on-chain side).
- Adding a confirmation dialog before Lookup. Disabling the control is the simplest correct fix.
- General-purpose concurrent-action gating across other bridge handlers. Scope is limited to the Lookup vs in-flight Register race.
- Two-tab race coordination (would require localStorage / BroadcastChannel coordination, out of beta scope).

## Cross-references

- `frontend/src/pages/bridge.js` — `handleRegister` snapshot site, `handleLookup` entry reset
- `frontend/src/pages/paper-detail.js` — `loadPaper` post-await identity guard as the canonical handler-side guard pattern (shape b reference)
- Sibling pending task: `ui-frontend-retry-timer-guard-sweep` covers a related concern (timer-guard adoption) on the same retry-loop site but does not address the mid-broadcast Lookup race

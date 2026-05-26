# UI-BRIDGE-IMPORT-QUEUE-UX — async submission UX + My imports surface

**Owner:** UI Agent
**Created:** 2026-05-21
**Priority:** P2

## Problem

The bridge import endpoint (`POST /api/bridge/register`) is moving from synchronous broadcast to async enqueue + `202 Accepted` with queue position and ETA (see `backend-bridge-import-queue.md`). The current frontend submission flow assumes synchronous success/failure and single-paper-at-a-time interaction. It has:

- no visible surface for queued or pending imports
- no handling for the new per-user concurrent-pending cap rejection
- no way for a user to see import status without keeping the submitting tab open

## Goal

Make the bridge import UX honest about the chain's pacing: surface queue position + ETA on submission, render the per-user cap rejection usefully, and add a "My imports" surface so users can come back later and see whether their pending imports completed.

## Scope

- **Submission response handling.** Show "Queued — position N, estimated completion in X" inline on `202`. Differentiate visually from the prior synchronous success state.
- **Per-user cap rejection.** Render the new cap-rejection 4xx with a clear message and remediation hint ("you have 5 pending imports; submission resumes once one completes"). Do not make it look like a transient chain error.
- **"My imports" surface.** New page or panel listing the current user's recent bridge import entries with state badges (pending / in-progress / completed / failed-with-reason). Reachable from the user's profile or main nav — exact placement to be decided during implementation. Reachable without keeping the submitting tab open.
- **Completion outcomes.** Completed entries link to the resulting on-chain bridge paper. Failed entries surface the reason and offer a retry-submission action where the failure class permits it (e.g., metadata source transient outage).

## Acceptance

- Submitting a bridge import shows queue position and ETA inline, without blocking the page.
- Submitting beyond the per-user cap shows the rejection reason and remediation hint, distinguishable from a transient chain error.
- "My imports" surface lists the current user's recent bridge import entries with correct state; completed entries link to the bridge paper, failed entries show the reason.
- Closing the submitting tab does not lose visibility of pending imports — opening "My imports" later shows current state.

## Out of scope

- Backend queue implementation, status endpoint shape, and submission-API semantics — see `backend-bridge-import-queue.md`.
- Push notifications on completion — the "My imports" surface is the visibility channel for v1.
- Bulk-submit UI (submitting N papers in one form) — single-paper submission is the current pattern and stays.

## Dependency

`backend-bridge-import-queue.md` defines the new `/api/bridge/register` response shape and the status endpoint(s) this surface consumes. UI scaffolding (component layout, design exploration, mocked data flows) can start in parallel; full integration depends on backend completion. Coordinate the status endpoint shape with the backend agent during their implementation rather than waiting for them to land first.

## Source

Brainstorm 2026-05-21 with user. The UX requirements (queue position + ETA, per-user cap surface, "My imports" view, completion visibility without keeping a tab open) emerged from the user-facing implications of the queue model selected on the backend side.

## Cross-references

- `backend-bridge-import-queue.md` — sibling backend task; defines the new response shape and status endpoint.
- `frontend/src/` — existing bridge import submission UI lives in the paper authoring flow.

[BLOCKED by Backend] (2026-05-21) — Sibling task `backend-bridge-import-queue.md` is still in `agents/docs/tasks/pending/`. Full integration is gated on:

- New `POST /api/bridge/register` 202 response shape (queue position + ETA representation).
- Per-user-cap rejection error code and `error.details` shape.
- Status endpoint(s) for "My imports" list (URL, query params, response shape).
- Retry-submission semantics (re-POST identifier vs. dedicated retry endpoint).
- `api-contracts/bridge.md` updates for the above.

**Scaffolding landed in this pass (consumable while backend implements):**

- New i18n keys for queued/cap-rejected states (in the `bridge` namespace) and the full `myImports` namespace, English source + stub rows for all 15 non-English locales, with `STUBS.md` sweep entry under `### Added 2026-05-21 (UI-BRIDGE-IMPORT-QUEUE-UX)`.
- New `/my-imports` page at `frontend/src/pages/my-imports.js`, registered in `pages/index.js` and routed by `router.js`. Auth-gated; signed-in users see the empty state in production; the `?demo=1` query param renders representative entries spanning pending / in-progress / completed / failed for design review.
- "My imports" link in the authenticated user dropdown (`frontend/index.html`), parallel to the Settings link.

**Consumer-side shape the UI binds against today** (see the docblock at the top of `frontend/src/pages/my-imports.js`):

```
{
  id:            string,
  identifier:    string,           // user-submitted DOI / arXiv / URL
  title:         string | null,
  state:         'pending' | 'in_progress' | 'completed' | 'failed',
  submitted_at:  ISO-8601 string,
  completed_at:  ISO-8601 string | null,
  author:        string | null,    // bridge account (completed only)
  permlink:      string | null,
  failure_reason:string | null,
  retriable:     boolean,
}
```

This is a starting point for backend-side shape negotiation, not a contract. Backend may name fields differently or split state into separate fields; the UI adapter (`loadEntries`) absorbs the difference.

**Still gated on backend (unwritten in this pass):**

- Wiring `registerBridgePaper()` to handle the 202 response and render the queued state with position + ETA on the bridge submission page (uses the already-shipped `bridge.queued*` keys).
- Rendering the per-user-cap rejection on the bridge submission page (uses the already-shipped `bridge.userCap*` keys).
- Replacing the empty stub in `my-imports.js` `loadEntries()` with a real fetch and an ETA-formatter that consumes `myImports.etaMinutes` / `etaHours` / `etaUnknown`.
- E2E coverage of the new submission flow and the My imports surface.

Move back to `pending/` once `backend-bridge-import-queue.md` archives and the new endpoints are documented in `agents/docs/api-contracts/bridge.md`.

## Architect unblock (2026-05-26)

Both gates are met; returning to `pending/`. `backend-bridge-import-queue` archived 2026-05-26, and `agents/docs/api-contracts/bridge.md` now documents the full surface this task binds against:

- `POST /api/bridge/register` → HTTP 202 `EnqueueBridgePaperResponse` with `queue_position` and `eta_seconds` (the queued-state shape).
- Per-user in-flight cap (5) → `RATE_LIMITED` (429), `error.details: { retriable, inflight, cap }`; resumes once one in-flight import completes.
- `GET /api/bridge/imports` → the "My imports" status/list endpoint (full field reference in `bridge.md`).
- Retry model → re-POST `/register` (no dedicated retry endpoint); a `failed` entry is not "in-flight" so it re-enqueues, while an active `pending`/`in_progress` duplicate returns `DUPLICATE`/`LOCK_HELD`.

Remaining work is all UI-side and is the task body, not a blocker: wire `registerBridgePaper()` to the 202 queued state and the cap rejection, replace `my-imports.js` `loadEntries()`'s empty stub with a real fetch against `GET /api/bridge/imports` (the `loadEntries` adapter absorbs any field-name differences from the consumer shape sketched above), add the ETA formatter, and add E2E coverage. Confirm the documented field names against the live `bridge.md` shape before binding — the earlier consumer sketch in this file predates the contract and was explicitly "not a contract."

## UI implementation note (2026-05-26) → review

Bound against the live `bridge.md` contract (not the predating consumer sketch). Landed:

- **Queued state (202).** `bridge.js` reads `queue_position`/`eta_seconds` off the 202 body, sets a `queued` step rendering position + ETA inline, links to `/my-imports`, and no longer redirects to a paper (the old synchronous `success` step + 3s redirect was removed). Consumes the already-shipped `bridge.queued*` keys.
- **Per-user cap.** Discriminated on `err.code === 'RATE_LIMITED' && err.details?.cap !== undefined` so the per-IP limiter (same code, no `details.cap`) falls through to the generic transient-error path. The cap surface (`bridge.userCap*`) is styled distinctly (amber remediation vs. crimson transient error).
- **My imports.** `my-imports.js` `loadEntries()` now fetches via the new `fetchBridgeImports()` (`src/api.js`, bearer-JWT, mirrors `fetchNotifications`); `adaptEntry()` absorbs field-name differences; failed entries re-POST `/register` (contract retry model) behind a re-entrancy guard. New shared `src/lib/format-eta.js` for the `eta_seconds` → localized label.

**Field-name adaptations (`adaptEntry`) against `bridge.md`:** `submitted_at`←`created_at`, `failure_reason`←`error_message`, `retriable`←`state === 'failed'` (no per-entry flag in the contract). 

**i18n:** consumed only already-shipped keys (`bridge.queued*`, `bridge.userCap*`, `myImports.*`). No new keys, no `STUBS.md` change. (`bridge.stepSuccess` is now orphaned but left in place, harmless.)

**[For architect — design gap, not blocking]** Completed entries from `GET /api/bridge/imports` carry no resolved bridge-author field, and `window.__PEVO_CONFIG__` does not expose the bridge account, so the "View paper" link only renders on the `existing_author` permlink-collision case; for a freshly broadcast bridge paper the link is suppressed (graceful degradation) rather than rendered broken. If completed entries should always link to the paper, the backend should add the resolved `author` to the entry shape or expose the bridge account in the injected config. Left as graceful degradation rather than guessing.

**Verification:** all touched/new unit suites pass (`pages-bridge`, `pages-my-imports`, `lib-format-eta`); `tests/e2e/bridge-import-queue.spec.js` passes (backend test-mode, dev routing restored after). Production `vite build` succeeds.

## Architect review (2026-05-26) — HELD PENDING FIXES (round 1):

`/ce-code-review` on the implementing diff (commits `5eb66f81` scaffold + `e53306fd` wiring; 9 personas — correctness + adversarial on Opus, api-contract/reliability/julik-frontend-races/testing/maintainability/project-standards/learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO). The substantive logic is correct — the queued/cap state machine, the per-IP-vs-per-user cap discrimination (`details.cap` presence), `formatEta` edge cases, the LOCK_HELD retry loop, and `bridge.js`'s own `_mounted` teardown guards all verified. The fixes below block archive. Land them, then `git mv` this file back to `tasks/review/`.

1. **(P1) `my-imports.js` has no teardown guard — add `createTimerGuard` + `_mounted` + `destroy()`.** `myImportsPage` is the only async page in `frontend/src/pages/` that does not spread `createTimerGuard()` (every sibling does, and `bridge.js` in this same diff does). `frontend/src/components/page-mount.js` calls `Alpine.destroyTree` on route change, so a `loadEntries()`/`retryEntry()`/`handleConnect()` that resolves after navigation writes reactive state (`this.entries`/`this.error`/`this.loading`/`this.retryingId`) and fires a toast on a destroyed component. Spread `createTimerGuard()` into the factory, add `destroy() { this._teardownTimers(); }`, and gate every post-`await` write with `if (!this._mounted) return;` (and `if (this._mounted) this.loading = false;` in the `finally`), matching the established pattern.

2. **(P2) `retryingId` scalar cannot serialize concurrent retries of distinct entries.** The `this.retryingId === entry.id` guard blocks a double-click on the same row but not a second retry on a different failed entry while the first is in flight; both reach `await registerBridgePaper`, and the success-reload race can re-enqueue. Backend dedups a re-POST of an active entry (`DUPLICATE`/`LOCK_HELD`), but the UI should not lean on that. Simplest fix: a single `isRetrying` boolean (one retry at a time) or a `Set` of in-flight ids; update the template `:disabled` binding accordingly.

3. **(P2) `retryEntry` swallows `DUPLICATE`/`RATE_LIMITED`+cap/`LOCK_HELD` into a generic toast.** A cap-hit or duplicate during retry shows the same misleading "try again" `common.error`. Discriminate `err.code` in the `retryEntry` catch before the generic fallback, mirroring `handleRegister`'s existing discrimination, so the user gets actionable feedback.

4. **(P3) `retriable` is hardcoded to `state === 'failed'`; derive it from `error_code`.** Per `bridge.md`'s `error_code` values, a terminal `BAD_REQUEST` (source gone) is not retriable, while `BROADCAST_*`/`SERVICE_UNAVAILABLE` are. The current hardcode shows a Retry on terminal failures whose re-POST deterministically re-fails, and leaves the `cannotRetry` template branch permanently dead. Derive `retriable` from `error_code` so the dead branch renders and guaranteed-fail retries are suppressed.

5. **(P3) `loadEntries` has no in-flight guard.** Concurrent calls (init + retry-success reload + error-banner Retry) last-writer-wins on `this.entries`. Benign today (idempotent reads, double skeleton flash) but a one-line `if (this.loading) return;` closes it.

6. **(P3) `queuedDetailText` fabricates "position 1" when the 202 omits `queue_position`.** `queue_position` is normally present per contract, so this is defensive: when `queuedPosition` is null, render a position-agnostic queued string rather than asserting a position the backend never sent.

7. **(P3) Delete the orphaned `bridge.stepSuccess` i18n key.** The synchronous-success step was replaced by `queued`; the key is unreferenced across `frontend/src` and `frontend/tests`. Remove it from `en.json` and all 15 locale stubs (and its `STUBS.md` row if present).

8. **(P3) Re-anchor the "earlier consumer sketch" comment.** The `adaptEntry` docblock in `my-imports.js` references the task file's predating consumer sketch, which becomes a dead pointer when this task archives (root `CLAUDE.md` "Comment anchors"). Reword to anchor on the stable `bridge.md` `GET /api/bridge/imports` contract instead.

9. **(P3) Document the full view-model shape.** The view-model docblock omits `discipline`, `keywords`, and `language`, which `adaptEntry` produces and `retryEntry` reads back when re-POSTing. Add them.

10. **(gated on `backend-bridge-imports-entry-enrich`) Wire title labels, per-row ETA, and the View-paper link for ALL completed entries.** This is the flagged design gap, resolved as "enrich the backend contract" (architect + user, 2026-05-26). `bridge.md`'s `GET /api/bridge/imports` entry now documents `title`, `eta_seconds`, and a resolved `author`; the backend task populates them. Once that lands: the `adaptEntry` seam already reads `wire.title`/`wire.eta_seconds`, so the only consumer edit is widening `author: wire.existing_author ?? null` to `wire.author ?? wire.existing_author ?? null` and dropping the `?demo=1`-only synthetic `title`/`eta_seconds` masking. **This item alone is gated on the backend task; items 1–9 are independent and land now** — which is why this file goes to `pending/`, not `blocked/`.

While addressing the above, also add the unit coverage the review found missing (fold into the relevant fix, do not over-harden): teardown-during-fetch (item 1), two concurrent `retryEntry` calls on distinct entries (item 2), a completed entry WITHOUT `existing_author`/`author` asserting the link is suppressed (until item 10 lands) then rendered (after), `badgeClass` switch, and `init(disconnected)`/`handleConnect`-rejection branches.

Verified-clean, no action: the synchronous-flag-before-await idempotency guard is satisfied (`retryingId` is set before the `await`) and the `finally` resets are unconditional — both compliant with the documented conventions. Dismissed: malformed/hostile wire `id` collapsing the `x-for :key` (confidence below the review gate; the contract guarantees a non-null unique `id`, and Alpine `x-text` auto-escapes so no XSS path).

## UI re-review signal (2026-05-26, commit 54ef2399) — round 1 fixes landed

Items 1-9 addressed; item 10 deliberately left (still gated on `backend-bridge-imports-entry-enrich`, which is in `pending/` — the `author:` widening is untouched). Per fix:

1. **(P1) teardown guard.** `my-imports.js` now spreads `createTimerGuard()`, adds `destroy() { this._teardownTimers(); }`, and gates every post-`await` write with `if (!this._mounted) return;` (`loadEntries`, `retryEntry`, `handleConnect`), with `if (this._mounted) this.loading = false;` in `loadEntries`'s `finally` — matching `bridge.js` and the other async pages.
2. **(P2) one-retry-at-a-time.** `retryEntry` bails on `this.retryingId !== null` (any row, not just the clicked one); the template's retry button binds `:disabled="retryingId !== null"`. `retryingId` keeps naming the active row while also serving as the global lock.
3. **(P2) retry error discrimination.** `retryEntry`'s catch discriminates `RATE_LIMITED`+`details.cap` (cap message), `LOCK_HELD` (`lockHeldRetry`), and `DUPLICATE` (treated as already-on-chain: reload + `duplicateWarning` success toast) before the generic `common.error` fallback — mirroring `handleRegister`.
4. **(P3) error_code-derived retriable.** New `NON_RETRIABLE_ERROR_CODES = {BAD_REQUEST}`; `retriable = state === 'failed' && !NON_RETRIABLE_ERROR_CODES.has(error_code)`. `BROADCAST_*`/`SERVICE_UNAVAILABLE` stay retriable. `buildDemoEntries` now carries both a terminal `BAD_REQUEST` row (renders `cannotRetry`) and a transient `BROADCAST_FAILED` row (renders `Retry`).
5. **(P3) loadEntries in-flight guard.** `if (this.loading) return;` at entry.
6. **(P3) queuedDetailText.** No longer fabricates `position ?? 1`; when `queuedPosition` is null it renders `bridge.queuedEtaOnly` (ETA present) or `bridge.queuedNoDetail` (no ETA).
7. **(P3) orphaned key.** `bridge.stepSuccess` removed from `en.json` and all 15 locale files. (It had real translations, not stubs, and no `STUBS.md` row — nothing to remove there.)
8. **(P3) docblock re-anchor.** `adaptEntry`'s docblock now anchors on the `GET /api/bridge/imports` entry shape in `bridge.md` (and the `error_code` value reference) instead of the task file's predating consumer sketch.
9. **(P3) view-model docblock.** Now lists `discipline`, `keywords`, `language`.

**New i18n:** `bridge.queuedEtaOnly`, `bridge.queuedNoDetail` (en + 15 raw-English stubs, `STUBS.md` sweep `### Added 2026-05-26 (UI-BRIDGE-IMPORT-QUEUE-UX)`).

**Coverage added** (`pages-my-imports.test.js`, `pages-bridge.test.js`): teardown-during-fetch and teardown-during-retry; one-retry-at-a-time across distinct entries; cap/LOCK_HELD/DUPLICATE retry discrimination; `error_code`-derived retriable matrix; completed-without-author link suppression; `badgeClass`; `init`-disconnected + `handleConnect`-rejection; `loadEntries` in-flight guard; `queuedDetailText` position-null (both ETA and no-ETA).

**Verification:** full unit suite green (1331 passed; the 3 `pages-edit.test.js` unhandled-rejection errors are pre-existing and unrelated — that file is not in this diff). `vite build` succeeds. E2E not re-run this round (no backend contract change; the changed surfaces are unit-covered).

## Architect re-review (2026-05-26) — round-1 items 1–9 VERIFIED FIXED; HELD PENDING FIXES (round 2):

Re-ran `/ce-code-review` on commit `54ef2399` (9 personas: correctness + adversarial on Opus; testing / maintainability / project-standards / julik-frontend-races / reliability / api-contract / learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO). **Round-1 hold items 1–9 are all verified correctly implemented** — teardown guard (`_mounted` gates every post-await write + the conditional `finally`), the one-retry-at-a-time lock (the flag is set synchronously before the first `await`, so it is race-tight), the RATE_LIMITED+cap / LOCK_HELD / DUPLICATE discrimination, the `error_code`-derived `retriable`, the `loadEntries` in-flight guard, `queuedDetailText`'s null-position × has-ETA matrix, orphaned-key removal (`bridge.stepSuccess` gone from all 16 locales with no dangling refs), the docblock re-anchor onto the `bridge.md` contract, and the view-model docblock completeness. **Item 10 correctly remains deferred** (gated on `backend-bridge-imports-entry-enrich`). i18n sweep, project standards, comment anchors, and contract field mappings are all clean.

The deeper round-2 pass surfaced 5 new findings (none were in the round-1 block). Land them, then `git mv` this file back to `tasks/review/`.

11. **(P2) `SERVICE_UNAVAILABLE` is missing from `NON_RETRIABLE_ERROR_CODES` in `my-imports.js`.** A terminal `failed` entry whose `error_code` is `SERVICE_UNAVAILABLE` (the bridge posting key was absent at dispatch — see the `error_code` reference under `GET /api/bridge/imports` in `bridge.md`) renders the Retry button, but re-POSTing `/register` deterministically re-fails with the same 503 until the operator redeploys with the key. Add `SERVICE_UNAVAILABLE` to `NON_RETRIABLE_ERROR_CODES` so such an entry renders the `cannotRetry` branch. This is safe: the transient HAF-unavailable variant of `SERVICE_UNAVAILABLE` reschedules server-side and never reaches `failed` state, so a `failed` entry carrying that code is always the terminal posting-key case. Update the `NON_RETRIABLE_ERROR_CODES` comment to record that reasoning, and add a row to the `error_code`-matrix test asserting `SERVICE_UNAVAILABLE` → `retriable: false`.

12. **(P2) `retryEntry`'s DUPLICATE branch mislabels an already-queued duplicate as "already registered on PEvO".** Per `bridge.md`, `DUPLICATE` covers two disjoint cases distinguished by `err.details`: already-on-chain (`{existing_author, existing_permlink}`) vs. already-queued (`{existing_entry_id, existing_entry_state}`). `retryEntry` blanket-shows the `bridge.duplicateWarning` success toast ("This preprint is already registered on PEvO.") for both, so an in-flight queued duplicate gets framed as a completed on-chain registration. Discriminate on `err.details` like `handleRegister` already does: keep the "already registered" success framing only when `existing_author`/`existing_permlink` are present; for the already-queued case show a neutral/informational message (still reload the list). Add a test for the already-queued DUPLICATE `details` shape.

13. **(P2 → test) No test pins the fail-open default in `adaptEntry`.** A `failed` entry with a null/undefined/unrecognized `error_code` derives `retriable: true` (because `NON_RETRIABLE_ERROR_CODES.has(undefined)` is `false`). This is shipped behavior with no test, so an accidental change to treat null/undefined as terminal would pass silently. Add a row to the `error_code`-matrix test asserting a `failed` entry with no `error_code` → `retriable: true`.

14. **(P3) `retryEntry`'s DUPLICATE-branch toast fires before `await this.loadEntries()`.** A route change during the reload can surface the toast on the next page. Move the toast call after the `await` and add a second `if (!this._mounted) return;` re-check before it, matching the post-await guard pattern used elsewhere in the file. The queued-success path has the same toast-before-await shape — fix both while you are in here.

15. **(P3) Retry on a `?demo=1` failed row re-POSTs `discipline: null` → guaranteed `BAD_REQUEST` against the live backend.** The demo affordance is for design review, but `retryEntry` still hits the real `/register`. Either add `discipline`/`keywords`/`language` to the failed demo rows in `buildDemoEntries()`, or short-circuit `retryEntry` while `?demo=1` is active so the demo never calls the live backend.

Items 11–12 are behavioral logic changes with companion tests; 13 is a test row; 14 is a guard reorder; 15 is a demo-data or guard fix. Keep the fixes minimal — do not over-harden. Two conf-below-gate testing nits the round-2 pass noted (assert `loading` stays `true` after teardown; assert `retryingId` resets in the LOCK_HELD test) are optional; fold them only if trivial.

Verified-clean, no action: all round-1 items 1–9; the one-retry-at-a-time lock (flag set synchronously before the first `await`); every teardown `_mounted` guard; the `loadEntries` in-flight guard's interaction with the retry-success reload; the `adaptEntry` contract field mappings (`created_at`/`error_message`/`eta_seconds`/`existing_permlink`, and `discipline`/`keywords`/`language` which the contract does return so live retries are well-formed); the i18n sweep; and the comment anchors. Dismissed below the confidence gate: a malformed-`id` `x-for :key` collapse (contract guarantees a unique non-null `id`; Alpine `x-text` auto-escapes).

## UI re-review signal (2026-05-26, commit 492959e7) — round-2 items 11-15 landed

All five round-2 items addressed in `my-imports.js` plus companion tests. Per item:

11. **(P2) `SERVICE_UNAVAILABLE` non-retriable.** Added to `NON_RETRIABLE_ERROR_CODES`. The comment now records the reasoning: this code's only `failed`-terminal cause is "bridge posting key not configured" (needs an operator redeploy, so a re-POST re-fails identically); its HAF-duplicate-check-unavailable variant reschedules server-side and never reaches `failed`, so a `failed` entry carrying it is always the terminal posting-key case. `BROADCAST_TIMEOUT`/`BROADCAST_FAILED` stay retriable (re-POST re-enqueues a fresh entry). The `error_code`-matrix test flips `SERVICE_UNAVAILABLE` → `retriable: false`.
12. **(P2) DUPLICATE retry discrimination.** `retryEntry`'s DUPLICATE branch now discriminates on `err.details` like `handleRegister`: on-chain (`existing_author`/`existing_permlink`) keeps the `bridge.duplicateWarning` "already registered" success framing; already-queued (`existing_entry_id`/`existing_entry_state`) shows a neutral queued notice (`bridge.queuedTitle`, `info`). Absent discriminator fields default to the neutral message rather than asserting a non-existent on-chain post. No new i18n key (reuses the shipped `bridge.queuedTitle`). Two tests pin both `details` shapes.
13. **(P2 → test) fail-open default pinned.** Added an `error_code`-matrix row asserting a `failed` entry with no/unrecognized `error_code` → `retriable: true`.
14. **(P3) toast-after-reload.** Both the queued-success path and the DUPLICATE branch now `await this.loadEntries()` first, then re-check `if (!this._mounted) return;`, then toast — so a route change during the reload can't surface the toast on the next page.
15. **(P3) demo retry short-circuit.** `retryEntry` returns early when `?demo=1` is active, so a demo retry never reaches the live `/register` (demo rows omit the discipline a real submission requires). Test asserts `registerBridgePaper` is not called in demo mode.

Item 10 remains deferred (still gated on `backend-bridge-imports-entry-enrich`; the `author:` widening and per-row title/ETA are untouched). The two conf-below-gate nits were folded in (LOCK_HELD `retryingId`-reset assertion; `loading` stays `true` after teardown).

**No i18n change** (reused already-shipped keys); **no `STUBS.md` change**.

**Verification:** full frontend unit suite green (1333 passed; the 3 pre-existing `pages-edit.test.js` unhandled-rejection errors are unrelated and not in this diff). `vite build` succeeds. E2E not re-run (no backend contract change; the changed retry/adapter surfaces are unit-covered).

## Architect re-review (2026-05-26, commit 492959e7) — round-2 items 11-15 VERIFIED FIXED; item 10 UNBLOCKED → pending/

Re-ran `/ce-code-review` on commit `492959e7` (9 personas: correctness + adversarial on Opus; testing / maintainability / project-standards / julik-frontend-races / reliability / api-contract / learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO). **All five round-2 hold items (11-15) are verified correctly implemented:**

- 11 `SERVICE_UNAVAILABLE` non-retriable — contract-faithful (the only terminal-`failed` cause is the posting-key-not-configured case; the HAF-unavailable variant reschedules server-side and never reaches `failed`).
- 12 DUPLICATE on-chain vs already-queued discrimination — correct; absent-discriminator default is the neutral queued notice.
- 13 fail-open retriable default — test pins it.
- 14 toast-after-await reorder — race-safe (one-retry lock + post-await `_mounted` rechecks).
- 15 demo short-circuit — placed before the `retryingId` set, so no lock leak.

No P0/P1 findings.

**Item 10 is now UNBLOCKED.** The backend already emits the enrich fields on `main`: `serializeQueueRow` returns `author` for completed entries (`existing_author ?? HIVE_BRIDGE_ACCOUNT`), plus `title` and a per-position `eta_seconds`; enqueue persists `title`; the `/imports` handler passes `queue_position`. `backend-bridge-imports-entry-enrich`'s R1/R2/R3 are implemented in the route, so the `adaptEntry` widening no longer waits on backend work. (That backend task still sits in `pending/` despite the code being live — flagged to the backend agent separately to move it to `review/`.)

**Remaining UI work (this is why the file returns to `pending/`, not archive):**

A. **(was item 10) Wire the View-paper link for ALL completed entries.** Widen `adaptEntry`'s `author: wire.existing_author ?? null` to `author: wire.author ?? wire.existing_author ?? null`, and drop the `?demo=1`-only synthetic `author`/`title`/`eta_seconds` masking in `buildDemoEntries` now that the real wire carries them. Confirm the field names against the live `GET /api/bridge/imports` response. Add a unit test: a completed fresh-broadcast entry (`author` set, `existing_author` null) renders the View-paper link (the current suite asserts only the suppression-on-null case).

B. **Cover the post-reload teardown guard.** The teardown test exercises the pre-reload `_mounted` guard only; add a case where `destroy()` fires during the post-success `loadEntries()` reload, asserting the success toast does NOT fire — exercising the second `_mounted` recheck the toast-after-await reorder added.

**Findings dismissed at triage (architect + user, 2026-05-26) — do not re-raise:**

- Per-IP `RATE_LIMITED` on retry falls to the generic toast and re-enables Retry immediately (reliability, P2). Pre-existing pattern shared with `bridge.js`'s `handleRegister`; out of this task's scope; would need a new i18n key + 16-locale sweep. Accepted as-is.
- `loadEntries` in-flight guard could no-op the post-retry reload, leaving a stale failed row (julik + adversarial, P3). Unreachable: the per-row Retry button renders only inside the `!loading` template branch, so no concurrent `loadEntries` can collide with the retry reload.
- Success/duplicate toast fires over a load-failed error banner if the reload sets `error` (adversarial, P3). The re-POST itself succeeded, so the success toast is not incorrect; only a cosmetic juxtaposition.
- Comments cite the `agents/docs/api-contracts/bridge.md` path (maintainability, P3). The contract-file + route citation is the prescribed anchor; `project-standards` approved it. The rot classes are line-numbers / SHAs / task-slugs, not contract-file+route citations.
- DUPLICATE with `details` entirely absent (`undefined`/`{}`) untested (testing, P3). The neutral else branch is already covered via the queued-shape test; the no-details sub-case is optional.

Move back to `review/` once A and B land.


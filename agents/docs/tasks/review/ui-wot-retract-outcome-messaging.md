# UI-WOT-RETRACT-OUTCOME-MESSAGING — retract UI ignores revocation_outcome and shows a success message for the fail-closed `unverified` / `query_error` arms

**Owner:** ui
**Created:** 2026-06-09 (surfaced by the wot-retract-cascaderevocation re-review, api-contract finding)
**Priority:** P2 (misleading UX on a trust-layer action; not a data-integrity bug)

## Problem

`POST /api/wot/retract` now returns a `revocation_outcome` discriminator: `revoked`, `skipped`, `unverified`, `timeout`, or `chain_error` (authoritative enum in `agents/docs/api-contracts/accreditation.md`). The SPA's `handleRetract()` in `frontend/src/components/vouch-section.js` reads only `res.data.revocations` and ignores `revocation_outcome`. When the backend fail-closes with `unverified` (the retraction is not yet confirmed on-chain: HAF lag, HAF unavailable, nothing was broadcast, or the single verify-and-re-evaluation read failed), `revocations` is `[]`, so the UI takes the "no revocations" path and shows the generic retract-success message. The user sees SUCCESS for a non-action or a failure.

## Goal

Surface the correct user-facing state per `revocation_outcome` so a fail-closed or error result is not shown as success.

### Suggested approach

In `handleRetract()`, branch on `revocation_outcome`:
- `revoked` / `skipped`: existing success copy is fine (revocation happened, or no revocation was needed).
- `unverified`: tell the user the retraction is not yet confirmed on-chain so dependent accreditations were not re-evaluated, and to re-check shortly. This is not an error; the on-chain retract may just be lagging ingestion, or the single verify-and-re-evaluation read failed (both fold into this fail-closed arm).
- `timeout` / `chain_error`: tell the user the revocation broadcast is in a degraded or failed state and to check on-chain status before re-attempting.

Add i18n keys for the new arms. `vouch_status` may be `null` in the `unverified` arm; guard any read of it.

## Acceptance

- The `unverified` arm renders a distinct, accurate message (not the success copy).
- `null` `vouch_status` is handled without a render error.
- Copy is emdash-free (PEvO user-facing-text convention).

## Related

- Backend contract: `agents/docs/api-contracts/accreditation.md` POST /api/wot/retract is the authoritative enum.
- The backend write-side hardening that introduced these outcomes is archived under the wot-retract-cascaderevocation work.

## UI implementation note (2026-06-09, commit cee02ffa on main)

`handleRetract()` in `frontend/src/components/vouch-section.js` now branches on
`res.data.revocation_outcome` (the retract `custom_json` already succeeded above;
the outcome describes the dependent-accreditation cascade revocation):
- `unverified` -> `step='success'` (green) with `wot.retractUnverified` ("not yet
  reflected on-chain, re-check shortly") — benign HAF-ingestion lag, explicitly
  not an error per the task.
- `query_error` -> `step='error'` (red) with `wot.retractQueryError` ("re-evaluation
  could not complete, re-attempt").
- `timeout` / `chain_error` -> `step='error'` with `wot.retractRevocationDegraded`
  ("degraded or failed, check on-chain status before re-attempting").
- `revoked` / `skipped` / absent (pre-discriminator response) -> the existing
  success copy, with the revoked accounts when present.

The profile template (`profile.js`) styles `message` binary: `step === 'error'`
renders red, anything else green — so the benign `unverified` lag stays green while
the actionable failures go red. `revocations` is read as `|| []` so the
non-revoked arms cannot throw. The task's "`vouch_status` may be null" guard is
N/A to this handler — `handleRetract` reads `revocations`/`revocation_outcome`,
never `vouch_status`; the post-retract `loadVouchStatus()` (unchanged) already
tolerates a null status.

**i18n.** 3 new `wot.*` keys in `en.json`, English stubs across the 15 other
locales (inserted textually via `fs` to preserve each locale's formatting/escaping
per the unicode-escape-corruption convention), and a STUBS.md sweep
`### Added 2026-06-09 (UI-WOT-RETRACT-OUTCOME-MESSAGING)` (45 lines). All copy is
emdash-free (verified).

**Tests.** 4 new `handleRetract` cases in `components-vouch-section.test.js`
(unverified -> non-error distinct message; query_error -> error; timeout +
chain_error -> degraded error; revoked -> success with accounts). Full frontend
unit suite green (1448 pass, +4; i18n parity across 16 locales holds); build green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` ran on the implementing commit `cee02ffa` (6 personas: correctness on Opus;
api-contract/testing/maintainability/project-standards/learnings on Sonnet; ce-agent-native
skipped per PEvO). The branch on `revocation_outcome` is **exhaustive** across all six enum arms
plus the absent/pre-discriminator case (backward-compatible via the `else` success arm);
`res.data.revocations || []` guards the non-revoked arms; the `unverified` green vs
`query_error`/`timeout`/`chain_error` red split is correct; i18n parity holds across all 16
locales + STUBS.md; copy is emdash-free; comment anchors are clean. One fix blocks archive.

1. **(P2) The `unverified` copy contradicts the contract's fail-closed semantics.**
   `wot.retractUnverified` reads "Vouch retracted. The revocation of dependent accreditations is
   not yet reflected on-chain; re-check shortly." Per the authoritative contract in
   `api-contracts/accreditation.md`, the `unverified` outcome means the RETRACTION ITSELF is not
   yet confirmed on-chain and is fail-closed: nothing was evaluated and NO dependent revocation
   was issued. The current copy instead tells the user a dependent revocation happened and is
   merely lagging ingestion (the opposite of fail-closed), and asserts the retract as definitely
   done. Reword so it (a) attributes the on-chain lag to the unconfirmed retraction rather than to
   a dependent revocation, and (b) states that dependent accreditations were not re-evaluated.
   Keep it green / non-error and keep the "re-check shortly" guidance (the retract `custom_json`
   was broadcast client-side; the backend simply has not confirmed it via HAF yet). Apply the
   equivalent reword across all 15 non-English locale stubs (the keys already exist; only the
   string values change) and keep STUBS.md in sync. Anchor any rationale on the `accreditation.md`
   `unverified` definition behaviorally; introduce no task-slug / round / line-number / SHA
   citation in code, test, or locale comments.

**Considered and dismissed (no action — do not implement):**
- (P2 to P3, forward-compat) A FUTURE new `revocation_outcome` fail-arm would fall to the `else`
  success branch and read as success. Speculative: no seventh arm exists, and adding one is a
  coordinated backend+frontend change; all six current arms are handled correctly and
  absent->success is required backward-compat. If ever hardened, distinguish absent (`undefined`
  -> success) from a non-empty unknown string (-> caution); do NOT add a `console.warn` (PEvO runs
  lean on logs). Not held.
- (P3) `skipped` has no dedicated unit test — it is structurally identical to the already-tested
  absent-outcome `else` path. Preemptive; not held.
- (pre-existing, not introduced by this diff) the `FE-ERR-MESSAGE-SANITIZE-...` task-slug comments
  and the `APP_TAG2` name in `vouch-section.js` — out of scope for this task.

Re-review acceptance: the `unverified` copy reworded across `en.json` + the 15 locale stubs to
match the contract's fail-closed semantics (retraction unconfirmed; dependents not re-evaluated),
STUBS.md kept in sync, full frontend unit suite green. `git mv` back to `tasks/review/` when done
(the move is the re-review signal).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI re-review signal (2026-06-09, working tree)

Reworded `wot.retractUnverified` across `en.json` + the 15 non-English locale
stubs (textual `fs` replace, preserving each locale's formatting/escaping). New
copy:

> Your vouch retraction was submitted but is not yet confirmed on-chain, so
> dependent accreditations were not re-evaluated. Re-check shortly.

This matches the contract's fail-closed `unverified` definition in
`api-contracts/accreditation.md` (the retraction itself is not yet reflected
on-chain; nothing evaluated, no revocation issued): the copy now (a) attributes
the on-chain lag to the unconfirmed retraction rather than to a dependent
revocation, (b) states dependent accreditations were not re-evaluated, and (c) no
longer asserts the retract as confirmed-done ("submitted but is not yet
confirmed"). It stays green / non-error (handler arm unchanged) and keeps the
re-check-shortly guidance. Emdash-free, verified across all 16 locales.

STUBS.md unchanged: `wot.retractUnverified` is still an untranslated stub under
its existing `### Added 2026-06-09 (UI-WOT-RETRACT-OUTCOME-MESSAGING)` heading, so
that entry is already accurate. No `### Updated` heading was added — that variant
exists for keys whose prior translation memory could mislead, and this key was
never translated, so re-stubbing the new English in place keeps it in sync without
duplicating the pending entry.

Tests: full frontend unit suite green (1448 pass, count unchanged — no test
added/removed; the `unverified` test asserts the i18n key, not the rendered
string). Build green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## [Architect] (2026-06-09) — HELD: backend removed `query_error`; the UI branch for it is now dead

This is a coordination hold raised during the architect review of the backend wot-retract batch (the poll-recount single-read collapse), not a re-review of the `unverified`-copy rework above — that rework is addressed and will be re-reviewed together with the items below when this task returns to `review/`.

The backend collapsed `POST /api/wot/retract`'s verification and re-evaluation into one HAF read and, as part of that, **removed the `query_error` `revocation_outcome` variant**: a re-evaluation read failure now fails closed to the existing `unverified` arm. This landed on main, and the authoritative contract `agents/docs/api-contracts/accreditation.md` was updated to the 5-arm enum `revoked` / `skipped` / `unverified` / `timeout` / `chain_error`. The backend can no longer ever return `query_error`. This task was implemented against the prior 6-arm enum, so it now ships a dead branch and orphaned strings.

Required fixes:

1. **Remove the dead `query_error` branch in `handleRetract`** (`frontend/src/components/vouch-section.js`). The `if (outcome === 'query_error')` arm and its red `wot.retractQueryError` message can never be reached.
2. **Remove the orphaned `wot.retractQueryError` i18n key** from `en.json` and all 15 non-English locale files, and drop its line from the `STUBS.md` `### Added 2026-06-09 (UI-WOT-RETRACT-OUTCOME-MESSAGING)` block. Keep i18n parity across all 16 locales.
3. **Remove the `query_error -> error` unit test case** in `components-vouch-section.test.js` (it pins a now-unreachable outcome — a fabricated-outcome test masking a dead branch).
4. **Confirm the `unverified` copy still reads correctly for the folded read-failure case.** The contract's `unverified` bullet now spans both "retraction not yet on-chain" AND "the single verify+re-evaluation read failed." The current copy ("submitted but is not yet confirmed on-chain, so dependent accreditations were not re-evaluated. Re-check shortly.") remains accurate for both causes (dependents were not re-evaluated; re-checking/retrying is the right guidance), so likely no change is needed — but verify the wording does not imply the cause is exclusively ingestion lag. No new copy is required if the current wording holds; document the decision.
5. **Update this task file's own stale enum references** (the Problem and Suggested approach sections still list `query_error` as a returnable outcome) so the task matches the 5-arm contract.

When the fixes land, `git mv` this file back to `tasks/review/`. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI re-review signal (2026-06-09, commit 1f6c9315 on main)

Addresses the [Architect] `query_error`-removal hold (items 1-5):

1. **Dead `query_error` branch removed** from `handleRetract` (`vouch-section.js`).
   The outcome chain now starts at `timeout`/`chain_error`; the `unverified` arm and
   the `else` success arm are unchanged.
2. **`wot.retractQueryError` removed** from `en.json` + the 15 non-English locale
   stubs (literal single-line delete, no JSON round-trip, so the prior round's
   reworded `retractUnverified` and each locale's non-ASCII content stay untouched),
   and its 15 lines dropped from the `### Added 2026-06-09
   (UI-WOT-RETRACT-OUTCOME-MESSAGING)` STUBS.md block. i18n parity across all 16
   locales holds (i18n.test.js green, 31 tests).
3. **`query_error -> error` unit case removed** from `components-vouch-section.test.js`
   (suite 20, -1).
4. **`unverified` copy confirmed unchanged.** The prior round's wording ("submitted
   but is not yet confirmed on-chain, so dependent accreditations were not
   re-evaluated. Re-check shortly.") stays accurate for the now-folded
   read-failure cause: it attributes the state to the unconfirmed retraction and to
   dependents not being re-evaluated, and does not imply the cause is exclusively
   ingestion lag. No copy change needed.
5. **This file's stale enum references updated.** Problem, Suggested approach, and
   Acceptance now describe the 5-arm contract
   (`revoked`/`skipped`/`unverified`/`timeout`/`chain_error`); the read-failure cause
   is folded into the `unverified` description.

Landing note: the worktree worker implemented against a base predating the prior
round's `retractUnverified` reword, so its commit conflicted on cherry-pick. The
removal was re-applied directly on current main: the three non-locale files reused
verbatim from the worker's verified edits, the 16 locales re-derived on the current
base to preserve the reworded `retractUnverified`. No `query_error` /
`retractQueryError` token remains anywhere under `frontend/`. Build green;
vouch-section + i18n parity unit tests green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

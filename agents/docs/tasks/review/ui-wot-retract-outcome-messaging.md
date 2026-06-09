# UI-WOT-RETRACT-OUTCOME-MESSAGING — retract UI ignores revocation_outcome and shows a success message for the fail-closed `unverified` / `query_error` arms

**Owner:** ui
**Created:** 2026-06-09 (surfaced by the wot-retract-cascaderevocation re-review, api-contract finding)
**Priority:** P2 (misleading UX on a trust-layer action; not a data-integrity bug)

## Problem

`POST /api/wot/retract` now returns a `revocation_outcome` discriminator: `revoked`, `skipped`, `unverified`, `query_error`, `timeout`, or `chain_error` (authoritative enum in `agents/docs/api-contracts/accreditation.md`). The SPA's `handleRetract()` in `frontend/src/components/vouch-section.js` reads only `res.data.revocations` and ignores `revocation_outcome`. When the backend fail-closes with `unverified` (the retraction is not yet reflected on-chain: HAF lag, HAF unavailable, or nothing was broadcast) or returns `query_error` (lookup failed), `revocations` is `[]`, so the UI takes the "no revocations" path and shows the generic retract-success message. The user sees SUCCESS for a non-action or a failure.

## Goal

Surface the correct user-facing state per `revocation_outcome` so a fail-closed or error result is not shown as success.

### Suggested approach

In `handleRetract()`, branch on `revocation_outcome`:
- `revoked` / `skipped`: existing success copy is fine (revocation happened, or no revocation was needed).
- `unverified`: tell the user the retraction is not yet reflected on-chain and to re-check shortly. This is not an error; the on-chain retract may just be lagging ingestion.
- `query_error`: tell the user the re-evaluation could not complete and to re-attempt.
- `timeout` / `chain_error`: tell the user the revocation broadcast is in a degraded or failed state and to check on-chain status before re-attempting.

Add i18n keys for the new arms. `vouch_status` may be `null` in the `unverified` arm; guard any read of it.

## Acceptance

- The `unverified` and `query_error` arms render a distinct, accurate message (not the success copy).
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

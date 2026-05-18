# UI-SETTINGS-EMAIL-SMTP-FAIL-COPY-SOFT-HINT — soften settings/email success toast for the Option-A SMTP-fail 200 path

**Owner:** UI Agent
**Created:** 2026-05-18 (architect, surfaced by cluster-B `/ce-code-review` on `backend-change-email-mint-path-and-followups` round-2 — api-contract reviewer AC-02)
**Priority:** P2

## Problem

Round-2 of `backend-change-email-mint-path-and-followups` switched `POST /api/settings/email`'s SMTP-failure response from `500 INTERNAL_ERROR` to `200 OK + logger.warn` (Option A per `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`). The change closes a status-code enumeration oracle ("email registered vs unregistered") and rolls back DB state on SMTP failure, so a user retry works correctly.

But the SPA caller `handleEmailSubmit` in `frontend/src/pages/settings.js` awaits `submitEmail` and on any non-throw (2xx) sets the success toast ("Verification email sent. Check your inbox.") and closes the form. Under the new SMTP-fail 200, the handler shows the success toast and closes the form — the user believes the email was dispatched when none was. There is no in-UI signal that a retry may be needed.

This is the intentional cost of Option A timing-equalization. The convention deliberately does NOT disclose SMTP failure at the wire layer because doing so re-introduces an oracle. But a SOFT in-UI hint that doesn't disclose SMTP state can still improve UX without compromising the convention.

## Goal

Soften the existing success toast copy so a user whose email never arrives (because of an SMTP outage) has a UX-level hint that a retry might be needed, without disclosing whether the failure was an SMTP fault or anything else. The message must be identical regardless of underlying outcome.

## Acceptance

1. Update the success toast copy in `frontend/src/pages/settings.js` `handleEmailSubmit` (and any matching i18n keys in `frontend/public/messages/en.json` plus stub locales). Approximate target: "Verification email sent. Check your inbox; if nothing arrives in a few minutes, try again." — or another phrasing that conveys the same soft retry hint.
2. The new copy must NOT distinguish SMTP-fail from genuine success at the wire layer or via any UI-visible signal — the message must fire identically in both cases.
3. No JS logic changes — purely a copy edit + i18n update.
4. Existing settings tests still pass (the toast assertion in `frontend/tests/unit/pages-settings.test.js`, if any, may need its expected string updated).

## Out of scope

- Changing the backend response shape or status code. The convention is settled.
- Distinguishing SMTP-fail from success via a structured field. That re-opens the oracle.
- Sweeping the same soft-hint pattern across every Option-A consumer in PEvO (e.g., `/api/auth/reset-request`, `/api/auth/recover`). Defer to a separate sweep task if the team wants the broader copy review.

## References

- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` (Option A canonical shape)
- `frontend/src/pages/settings.js` `handleEmailSubmit` (the SPA caller)
- `frontend/public/messages/en.json` (canonical copy source; stub locales mirror)
- `backend/src/routes/settings.ts` POST `/email` (the backend handler; reference only — backend zone, do not edit)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

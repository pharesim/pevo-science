# UI-ORCID-CALLBACK-RETRIABLE-MACHINERY-REMOVE — Strip the now-unused auto-retry machinery from orcid-callback.js

**Owner:** ui
**Created:** 2026-04-29 (architect, follow-on to ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 — Option B chosen)
**Priority:** P2
**Source:** `agents/docs/tasks-archive.md` ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 (decision recorded 2026-04-29).

## Problem

The architect decision on the same-tick lock-contention 409 contract is to drop the `retriable: true` discriminator backend-side. The discriminator was never reachable in practice — the OAuth state token is consumed before lock acquisition, so the frontend's same-`{code, state}` retry lands on 400 BAD_REQUEST instead of the retried-and-succeeding operation.

Once `backend-orcid-droplockcontention-retriable.md` lands, the frontend's auto-retry machinery in `frontend/src/pages/orcid-callback.js` becomes dead code: no current 409 emits `retriable: true`, the `BROADCAST_TIMEOUT` 504 has `retriable: false`, and `BROADCAST_FAILED` 502 has `retriable: false`. The machinery should be removed in full to prevent silent contract-drift if a future retriable surface is added that doesn't actually work.

## Scope

Cleanup confined to `frontend/src/pages/orcid-callback.js`. The `errorKind === 'alreadyLinkedRetriable'` branch in the template (line 42) becomes unreachable; remove the branch and the parameterized i18n call so the template renders the static `errorMessage` for the durable-binding 409.

Specific surface to remove (line numbers from the current file at 4ed2afe-ish — re-verify before editing):

1. **Constants** — `MAX_RETRIES = 1` (line 9) and the surrounding header comment (lines 5-9) explaining the cap.
2. **Reactive state** — `errorKind` (line 79, if only used by `alreadyLinkedRetriable`; verify by grep — the field's docstring at line 79 says "`'alreadyLinkedRetriable'` surfaces countdown-parameterized i18n; other branches render the static errorMessage key", which suggests it's the only consumer), `retryCountdown` (line 80), `_retryCount` (line 88) and its docstring (lines 81-87).
3. **Reset hook in `init` / `_verify`** — `this._retryCount = 0` (lines 130 and 221).
4. **Catch-block branch in `_verify`** — the `retriable` detection block at lines 148-181 (everything that arms the countdown). The catch should fall through to the durable-binding rendering for any 409 ORCID_ALREADY_LINKED.
5. **Template** — line 42's `errorKind === 'alreadyLinkedRetriable' ? $t('orcid.alreadyLinkedRetriable', { seconds: retryCountdown }) : errorMessage` collapses to just `errorMessage`. Line 54's `:disabled="retryCountdown > 0"` collapses to a non-disabled retry button (or remove the disabled binding entirely).
6. **Methods** — `_retryVerify` (line 272) and the countdown-tick method around lines 254-268 are deleted in full.
7. **Locale strings** — `orcid.alreadyLinkedRetriable` becomes orphaned. Search the locale files (`grep -rn "alreadyLinkedRetriable" frontend/src/`) and remove the key from each language. Likewise any helper i18n-key reference.
8. **Stash slot** — `_lastVerifyArgs` (used to stage the same-state replay for `_retryVerify`) becomes unused. Remove it AND the `this._lastVerifyArgs = { code, state, mode }` write site in `_verify`. Re-grep to confirm no other consumer.

## Tests

- Existing E2E `ui-e2e-edit-paper-flow.md`-style tests should not be touched by this change — the ORCID callback E2E coverage is in `ui-orcid-callback-retriable-branch.md` (already in `tasks/review/` archive flow). After this cleanup, any test that exercises the auto-retry path needs to be either deleted (the path is gone) or rewritten to assert the new "durable 409 → restart OAuth" behavior. Identify the test file(s) via `grep -rn "_retryVerify\|alreadyLinkedRetriable\|retriable.*true\|MAX_RETRIES" frontend/test/` and judge each one.
- Add or extend an E2E (or unit) assertion: ORCID 409 with `error.code === 'ORCID_ALREADY_LINKED'` (any cause) renders the durable error message and the retry button is the standard non-countdown variant. The button click triggers `_verify`, not `_retryVerify`. (If this overlaps with existing `ui-e2e-...` coverage, just verify the existing test still passes after machinery removal and document which test covers the durable rendering.)

## Out of scope

- Backend wire-shape change is in `backend-orcid-droplockcontention-retriable.md` — coordinate landing order. UI cleanup can land any time after backend stops emitting `retriable: true`; the dead branch is harmless until then.
- The `BROADCAST_TIMEOUT` 504 / `BROADCAST_FAILED` 502 / `POST_BROADCAST_FAILED` 502 surfaces in the same callback file are unchanged. They were always `retriable: false` and rendered the durable message.
- Re-introducing a retriable surface elsewhere in the API. The `_retryCount` + countdown pattern was correct in shape but composed with a single-use state token. If a future endpoint genuinely supports same-state retry, it can re-derive a similar countdown from a fresh design — do NOT preserve the deleted machinery as scaffolding.

## Acceptance

- `grep -rn "_retryCount\|MAX_RETRIES\|retryCountdown\|_retryVerify\|alreadyLinkedRetriable" frontend/src/` returns no hits.
- `grep -rn "_lastVerifyArgs" frontend/src/` returns no hits.
- ORCID callback page renders the durable `ORCID_ALREADY_LINKED` message on every 409 cause, with a non-countdown retry button (or a "restart OAuth" CTA — UI judgment).
- Locale keys `orcid.alreadyLinkedRetriable` removed from every language file.
- Architect reviews the diff before archive.

## Source

- `tasks-archive.md` ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 (decision Option B, 2026-04-29).
- `frontend/src/pages/orcid-callback.js` lines 5-9, 42, 54, 78-90, 130, 148-181, 221, 254-268, 272-289 (re-verify; commits since the round-2 hold may have shifted line numbers).
- Backend companion task: `backend-orcid-droplockcontention-retriable.md`.

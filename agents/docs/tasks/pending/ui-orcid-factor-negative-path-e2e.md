# UI-ORCID-FACTOR-NEGATIVE-PATH-E2E — assert §6.5 invariant #2 (registered-factor mismatch → 403) in the ORCID round-trip

**Owner:** UI (owns `frontend/tests/e2e/`)
**Created:** 2026-06-09 (architect, code-review follow-up from the orcid-stub E2E standup)
**Priority:** P3

## Context

The E2E stack now ships the `orcid-stub` OAuth sidecar (`docker-compose.test.override.yml`), and `ui-orcid-stub-real-roundtrip-unfixme` covers driving the happy-path real round-trip: seed `accounts.orcid = <iD>`, fulfil the browser authorize hop in-page with `code = <same iD>`, and let the real `/api/orcid/callback` mint a `fresh_auth` proof.

The happy path alone cannot catch a regression in §6.5 invariant #2 (the registered-factor equality check). Because the stub reflects the submitted `code` straight back as the token-response `orcid`, a backend bug that trusted the reflected iD without comparing it to `accounts.orcid` would still pass the happy path. Only a mismatch case actually exercises the equality.

## Goal

Add a negative-path E2E case (in `settings-orcid-factor.spec.js` or a sibling ORCID spec) that:

- Seeds `accounts.orcid = A`, a valid per-run ORCID-iD-format value.
- Drives the authorize-fulfil with `code = B`, where B is a DIFFERENT but still ORCID-iD-format value (so it clears the `ORCID_RE` format gate and reaches the equality check rather than the 400 format path).
- Asserts the real `/api/orcid/callback` returns 403 FORBIDDEN (binding / registered-factor mismatch) and that no proof is minted / the action does not complete.

## Notes / gotchas

- The driven `code` for BOTH the positive and negative cases must be ORCID-iD-format (`NNNN-NNNN-NNNN-NNN[X]`). A non-conformant value 400s on `ORCID_RE` before the equality check, which would make the negative case pass for the wrong reason. Use two distinct valid iDs for A and B.
- Playwright route-timing: register the `**/oauth/authorize*` `page.route` interception BEFORE the action that triggers navigation to the authorize URL (e.g. wrap the trigger and `page.waitForRequest` in `Promise.all`), or the browser can outrace the interception, follow the real ORCID URL, and hang the test.

## References

- `docker-compose.test.override.yml` — the `orcid-stub` service + backend `ORCID_*` env; the reflected-`code` contract is documented inline.
- `backend/src/routes/orcid.ts` — `/callback`: the `ORCID_RE` format gate, then the per-mode handlers' `(orcidId, accounts.orcid)` equality check.
- `ui-orcid-stub-real-roundtrip-unfixme` — the happy-path sibling task; land that first, since this builds on the same harness and seeding helpers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI completion note (2026-06-09, commit 80c0b8de on main)

Landed in `settings-orcid-factor.spec.js` as a new isolated describe
("settings — ORCID-factor set_password registered-factor mismatch (State C)")
with one test: seeds `accounts.orcid = A` (per-run-unique, valid format), drives
the set_password ORCID factor through the same redirect-host bridge +
authorize-fulfil harness as the happy path, but fulfils the authorize hop with
`code = B` where `B = 0000-0002-1825-0097` (a distinct, canonical valid-format iD;
the test asserts `B !== A`). The real `/api/orcid/callback` returns **403
FORBIDDEN** (`error.code === 'FORBIDDEN'`) at handleFreshAuth's `accountOrcid !==
orcidId` check, and the test confirms no proof was minted — the consent-op cache
is null and `accounts.password_hash` stays NULL.

Both gotchas from the task were honored: B is ORCID-iD-format so it clears
`ORCID_RE` and reaches the equality check (not a 400 format path), and the
`**/oauth/authorize*` route is registered before the submit that triggers the
navigation.

Isolation: this account is separate from the happy-path account (which the real
set_password mutates to State B). `seedStateCAccount` and `seedSession` were
parametrized so the two describes never share a row.

Verification: `settings-orcid-factor.spec.js` runs 4/4 green against the test
stack (the three happy-path/seam tests + this negative-path test).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` (correctness + adversarial + testing) surfaced one finding on
the negative-path test, raised independently by all three reviewers:

1. **The 403 assertion is not regression-proof — it cannot prove WHICH 403 fired.**
   The test asserts only `cbResp.status() === 403` and `cbBody.error.code ===
   'FORBIDDEN'`. But `/api/orcid/callback` has TWO exits that emit exactly that
   envelope:
   - the caller-mismatch guard ("Callback caller does not match initiator"),
     reachable because `fresh_auth` is an authenticated mode; and
   - the registered-factor equality guard ("The ORCID you authenticated with is
     not linked to this account."), which is the §6.5 invariant #2 path this test
     exists to cover.

   Today's construction (callback caller == /start initiator == NEG_USERNAME)
   routes deterministically to the factor guard, so the test is correct against
   current code. But the assertion can't prove it: a future regression that
   decoupled the two username derivations would 403 via the caller guard, and the
   test would stay green while invariant #2 went silently unexercised — precisely
   the false-pass this task was created to prevent.

   **Fix:** after the `error.code` assertion, also assert the distinguishing
   error message — that `error.message` equals the factor guard's message ("The
   ORCID you authenticated with is not linked to this account."). A caller-guard
   403 then fails the test instead of passing it. Anchor on the message text, not
   on a backend line number.

   **Verify:** re-run the mismatch test against the test stack and confirm it
   still 403s green with the message assertion added.

When this lands, `git mv` this file back to `tasks/review/`.

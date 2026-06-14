# ORCID callback error messages: de-hardcode count, fix mis-mapped + generic errors

**Owner:** ui
**Created:** 2026-06-14

The ORCID callback page (`frontend/src/pages/orcid-callback.js`, the `_verify`
error-branching) maps backend errors to fixed i18n copy by error **code** only,
which produces a hardcoded works count, one factually-wrong message, and a generic
fallback that also offers an unsafe retry. From a 2026-06-14 audit of the ORCID
signup error-message coverage.

## Acceptance criteria

1. **De-hardcode the works count.** `signup.orcidInsufficientWorks` bakes "3" into
   the string across all 16 locale files (`frontend/public/messages/*.json`).
   Depends on the backend adding `details: { required, have }` to the
   insufficient-works 422 (see `backend-orcid-works-gate-error-details`).
   Parameterize the string to use `{min}` (the `interpolate()` helper in
   `frontend/src/i18n.js` already supports `{var}`); consider also surfacing
   `{have}` so the user sees what they currently have. In `_verify`, pass
   `{ min: err.details?.required, have: err.details?.have }` to `$t`, with a sane
   fallback when `details` is absent. The frontend currently discards the
   backend's accurate message entirely, so the parameterized copy is the only
   place the real number can reach the user.

2. **Fix the VALIDATION_ERROR mis-mapping.** `_verify` maps **any**
   `VALIDATION_ERROR` to `signup.orcidInsufficientWorks`. Accredit-mode's
   `422 "Account is already accredited"` (from `handleAccredit`) therefore renders
   "needs at least N works", which is wrong and non-actionable. Branch on a more
   specific signal — e.g. the presence of the works-count `details` shape now
   carried only by that 422, or the originating mode — so non-works
   VALIDATION_ERRORs do not borrow the works copy.

3. **De-generic the timeout / ORCID-down cases.** `ORCID_PROVIDER_TIMEOUT` (504)
   and `INTERNAL_ERROR` (500, e.g. an ORCID `/works` outage) fall through to the
   generic `orcid.verificationFailed` AND get the generic affordance, which offers
   an immediate "Try Again" — exactly the unsafe retry the backend's 504
   `verify_before_retry: true` / `outcome: 'timeout'` hint warns against (an
   immediate retry can double-spend the auth code). Add a dedicated 504 branch
   that surfaces the provider-timeout copy and does NOT offer a one-tap immediate
   retry, and ideally a distinct message for ORCID-side outages.

4. **(Lower priority) Pre-flight + cause-disambiguating copy.** The signup page
   (`frontend/src/pages/signup.js`) never states the requirement before the OAuth
   round-trip, so the user only learns it on rejection. Add a short pre-flight
   note near the ORCID buttons, and/or expand the insufficient-works copy to cover
   the two distinct failure modes that produce the identical rejection: (a)
   self-asserted (manually added) works do not count — only works indexed by an
   external source (Crossref/Scopus/DataCite) do; (b) external works must be set
   to "Everyone" visibility, or the public ORCID API cannot see them. The backend
   cannot currently tell these apart (see backend task's out-of-scope note), so
   covering both in one message is the achievable win.

5. **Add regression coverage.** The existing test
   (`frontend/tests/unit/pages-orcid-callback.test.js`) asserts only the i18n KEY
   (`signup.orcidInsufficientWorks`), so it would not catch a hardcoded-number or
   wording regression. Add assertions on the resolved string and the interpolated
   `{min}` value.

## Context

- Distinct from `blocked/ui-orcid-signup-recover-real-roundtrip.md`, which is about
  E2E real-roundtrip coverage, not error copy.
- The literal "no external works" case already shows reasonable copy
  (`signup.orcidInsufficientWorks`); this task is about the hardcoded number plus
  the adjacent blockers whose messages are wrong (item 2) or generic (item 3).

## Architect re-review (2026-06-14) — HELD PENDING FIXES

`/ce-code-review` on the implementation diff confirmed all five acceptance
criteria are met (de-hardcoded `{min}`, mis-map fixed, timeout/outage de-genericized,
pre-flight note, resolved-string tests). No P0/P1. Two polish fixes block archive;
the rest of the review surfaced advisory-only items that were dismissed (see below).

1. **`orcid.serviceUnavailable` copy contradicts its no-button affordance.** The
   `INTERNAL_ERROR` branch sets `errorAction = 'timeout'`, which renders no retry
   button (same as `ORCID_PROVIDER_TIMEOUT`'s broadcast-less path). But
   `orcid.serviceUnavailable` ends with "Please wait a moment and try again," which
   implies a clickable retry that is not there. Its sibling `orcid.providerTimeout`
   was deliberately worded "wait a moment, then start over" to avoid that
   implication. Reword `orcid.serviceUnavailable` to the same "start over" framing
   so the copy matches the affordance. Re-stub the new wording across all 16 locale
   files and record it in `STUBS.md` under the existing `### Updated` sweep heading
   for this work (the key is already a stub, so reuse `### Updated`, not `### Added`).

2. **`INTERNAL_ERROR` branch comment overstates the state-consumption guarantee.**
   The comment asserts unconditionally that "the state is consumed downstream of the
   consume DEL, so a same-code retry returns 400." Per `api-contracts/orcid.md`
   ("State consumption semantics"), pre-consume `INTERNAL_ERROR` paths (a throw from
   the state-read `redis.get` or the auth-dispatch path before the auth check) map to
   500 with `state` PRESERVED. Reword the comment to qualify the claim: state is
   consumed only when the throw originates downstream of the consume DEL; withholding
   the one-tap retry is the correct affordance regardless, because the client cannot
   distinguish the pre-consume and post-consume cases. Behavior is unchanged — comment
   accuracy only.

Dismissed (no action required, recorded for the implementer's awareness):
- The `|| mode === 'signup'` arm of the works-copy discriminator is a forward-compat
  trap only (it would borrow works copy for a hypothetical future non-works signup
  `VALIDATION_ERROR` with no numeric `required`). It is the approach this task
  prescribed and the backend now emits `details.required`, so the arm is a
  largely-dead transitional window. Left as-is.
- The `errorAction` field-declaration comment density is a maintainability taste call.
- `BROADCAST_FAILED` (502) falling through to the generic copy is out of scope for
  this task and pre-dates this diff.
- A STUBS.md heading-anchor flag was dismissed as a false positive: the
  `### Added/Updated <date> (<TASK-SLUG>)` format is mandated by `agents/ui/CLAUDE.md`.

When both fixes land, `git mv` this file back to `tasks/review/` — the move is the
re-review signal.

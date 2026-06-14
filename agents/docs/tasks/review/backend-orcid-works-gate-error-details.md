# ORCID works-gate: structured error details + threshold de-hardcode (backend)

**Owner:** backend
**Created:** 2026-06-14

The ORCID signup/accredit works-count rejection emits a `422 VALIDATION_ERROR` but
carries **no structured `details`**, so the SPA cannot show the real numbers and
instead hardcodes "3" in its copy. The backend already builds an accurate, dynamic
human message but the frontend discards it. Give the client the numbers as data.

From a 2026-06-14 audit of the ORCID signup error-message coverage. The literal
"no external works" case already shows a decent message; this task fixes the
de-hardcode half on the backend side.

## Acceptance criteria

1. In `handleSignup` and `handleAccredit` (`backend/src/routes/orcid.ts`), on the
   `externalWorksCount < config.orcidMinWorks` branch, pass a details payload to
   `sendError`: `{ required: config.orcidMinWorks, have: externalWorksCount }`.
   Keep the existing human message string. `sendError` (`backend/src/response.ts`)
   already supports a `details` arg that becomes `error.details`.

2. Add backend test coverage that drives the external-works count **below** the
   threshold. Today the shared `installOrcidFetchStub` helper always serves
   `works: 3`, which clears the gate — there is no `works: 0/1/2` case anywhere,
   so the rejection branch and its message/threshold are completely unguarded.
   Assert: 422 status, `VALIDATION_ERROR` code, `details.required === config.orcidMinWorks`,
   `details.have === <served count>`.

3. Document the contract change in `agents/docs/api-contracts/orcid.md`: the
   insufficient-works 422 now includes `details: { required, have }`. That file is
   architect-owned and subject to the no-emdash rule — coordinate with / hand to
   the architect, or stage it with the architect on a `[skip-zone-audit]` commit.

4. `.env.example` now documents `ORCID_MIN_WORKS` (landed 2026-06-14 in the
   task-filing commit). No further env change needed here.

## Context / out of scope

- `config.orcidMinWorks = parseInt(process.env.ORCID_MIN_WORKS || '3', 10)`
  (`backend/src/config.ts`). Not overridden in `.env`, so 3 applies today; the
  frontend's hardcoded "3" is coincidentally correct but lies if the env changes.

- **Private/limited-visibility conflation (deeper, NOT in scope here).**
  `countExternalWorks` fetches `pub.orcid.org` **anonymously** (no Authorization
  header; the access token is intentionally unused). The public API returns only
  "Everyone"-visibility works, so a profile whose external works are set to
  "Trusted parties"/"Only me" returns count 0 and produces the **identical**
  insufficient-works rejection as a genuinely self-asserted-only profile. The
  remedies differ (change ORCID visibility vs. get works externally indexed).
  Distinguishing them at the data level needs the ORCID Member API
  (`/read-limited` scope, paid membership) — out of scope. The UI task covers
  both causes in the user-facing copy instead.

- **ORCID `/works` outage surfaces as a generic 500.** The non-OK throw in
  `countExternalWorks` (`'Failed to fetch ORCID works'`) is a plain `Error`, not an
  `OrcidProviderTimeoutError`, so an ORCID-side outage reaches the user as the
  generic `INTERNAL_ERROR` `'ORCID verification failed'`, indistinguishable from a
  real failure. Optional follow-up: throw a typed error so the route can map
  ORCID-side outages to a distinct code the UI can message as transient. Lower
  priority than items 1-2.

## Backend implementation note (2026-06-14, working tree)

Items 1, 2, 4 landed. Item 3 (contract) handed to the architect below.

- **Item 1 — structured details.** Both works-gate branches in
  `backend/src/routes/orcid.ts` (`handleSignup` and `handleAccredit`, the
  `externalWorksCount < config.orcidMinWorks` branch) now pass a fifth arg to
  `sendError`: `{ required: config.orcidMinWorks, have: externalWorksCount }`.
  The two branches were byte-identical, so this was a single `replace_all`. The
  existing human message string is unchanged. `sendError`
  (`backend/src/response.ts`) already promotes the 5th arg to `error.details`.
- **Item 2 — test coverage.** New describe block in
  `backend/tests/routes/orcid.test.ts` ("insufficient external works
  (works-gate 422 + details)") with two specs that drive the count below the
  threshold (the shared `installOrcidFetchStub` previously only ever served
  `works: config.orcidMinWorks`, so the rejection branch was wholly unguarded):
  - signup, `works = config.orcidMinWorks - 1`: asserts 422, `VALIDATION_ERROR`,
    `details` deep-equals `{ required: config.orcidMinWorks, have: served }`, the
    human message is preserved, and no broadcast fires. `have` is asserted
    against a served count distinct from `required` so a hardcode of either
    number fails loudly.
  - accredit, `works = 0`: asserts 422, `VALIDATION_ERROR`, `details.have === 0`,
    no broadcast. Confirms the gate precedes the admin broadcast (default mock
    leaves the account un-accredited, so the flow reaches the works gate rather
    than short-circuiting at "already accredited").
  - Full `orcid.test.ts` green (107 passed). `npm run typecheck` + `npm run lint`
    clean (the lone lint warning is a pre-existing unused-eslint-disable in
    `src/lib/author-supersession.ts`, untouched here).
- **Item 4 — env doc.** Already present per the task; no change made.

### [TODO Architect] Item 3 — contract update in `agents/docs/api-contracts/orcid.md`

Backend does not edit architect-owned contract files (categorical, per
`agents/backend/CLAUDE.md`). The insufficient-works 422 now carries structured
`details`. The relevant entry is the line reading
`VALIDATION_ERROR -- ORCID profile has fewer than ORCID_MIN_WORKS works
(signup/accredit modes only)` in the `/callback` error-codes list. Suggested
wording (emdash-free for the contract's no-emdash rule):

> `VALIDATION_ERROR` (422) -- ORCID profile has fewer than `ORCID_MIN_WORKS`
> externally-sourced works (signup and accredit modes only). Carries
> `details: { required, have }`, where `required` echoes the configured
> `ORCID_MIN_WORKS` and `have` is the counted external works. The SPA renders
> these numbers instead of a hardcoded threshold. Consumers MUST access the
> fields by key name, not position.

The signup-mode step description near "Check `ORCID_MIN_WORKS` (default 3)" and
the accredit-mode equivalent may also note the `details` payload if the
architect wants symmetry with the other documented error shapes.

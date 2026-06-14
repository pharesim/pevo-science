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

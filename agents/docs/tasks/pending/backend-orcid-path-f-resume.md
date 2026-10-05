# ORCID-path F rows that lost their auth token cannot resume signup

**Owner:** backend
**Created:** 2026-10-05
**Priority:** normal

Filed at the architect archive of the password-reset account-state gate (archived 2026-10-05).
This is the follow-up the user approved there, when choosing to ship the default rule ("reset
rotates an existing password and never adds one") although it closes a route back for these
rows. User triage: "as recommended".

## Why

A state F row from the ORCID signup path (ARCHITECTURE.md § 6.1) has no password. Its signup
continues with the `auth_token` the browser holds. The backend measured, in that task's signal
block, that a user who loses the token has no way back: signing up again answers 409 "Email
already verified", ORCID login answers 404 `NO_ACCOUNT`, `POST /api/auth/resume-signup` refuses
a passwordless row by design, and `signup-cleanup` reaps an F row only by `created_at`, after 30
days. Before the gate, a row with an email had one route back: reset added a password, then
`/resume-signup` answered 200. The gate closed it, because it handed an ORCID-verified pending
signup to whoever held an email the ORCID path never verified. An ORCID-path F row without an
email never had a route.

## Scope

1. Measure first: drive each door above for an ORCID-path F row with and without an email, and
   record what each answers (route tests, real Postgres). The list above is the earlier signal's;
   go by your measurement.
2. Propose a resume path whose proof is the ORCID the row signed up with (an ORCID OAuth round
   trip, the factor the row registered; § 6.5 invariant #3) and that hands back the row's
   `auth_token`, as `/resume-signup` does for an email-path row. A new route or a mode on an
   existing ORCID route is your call.
3. It is an API shape change. Before writing the route, move this file to `blocked/` with a
   `[BLOCKED by Architect]` note giving the proposed shape: route, request, response, errors,
   and which § 6.1 states it admits. The architect updates ARCHITECTURE.md and the API contract,
   files the UI task, and moves this file back.
4. Then implement it. It admits only an ORCID-path F row whose ORCID matches the proven one, and
   it answers a finalized row as it answers an unknown ORCID.

## Acceptance criteria

1. Route tests pin each door from Scope item 1, and each admitted and refused state of the new
   path, against real Postgres.
2. An ORCID-path F row, with or without an email, can resume signup after losing its
   `auth_token`, given the ORCID it signed up with.

# A failed sanction read answers a retriable 503, not a sanction refusal

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed from the architect review of `ui-accreditation-binding-refusal-states` (finding #1, P1,
decided with the user 2026-10-06). Rule: `ARCHITECTURE.md` "Data Source Policy", item 1: when HAF
cannot answer a read, the request fails with a retriable 503 and never a substitute answer.

## Why

`hasUnliftedSanction` (`backend/src/accreditation.ts`) returns `true` when `getPool()` is null or
the query throws, the same value it returns for a real sanction, and every HTTP caller answers
that with 403 `ACCREDITATION_SANCTIONED`. At signup finalize the SPA routes that 403 to a final
"not eligible for accreditation" screen with no retry (`_handleFinalizeRefusal` in
`frontend/src/pages/signup-verify.js`), so a HAF outage tells a new user their account is not
eligible. On `/confirm` the account is minutes old and cannot carry a sanction. Before that SPA
change, re-submitting reached the 1-hour stuck-resume branch and recovered. The comment in
`backend/src/routes/accreditation-metadata.ts` accepts the misleading 403 because it resolves on
the client's next retry; at finalize there is no longer a next retry.

## Scope

1. Give the sanction read an outcome that tells "sanctioned", "not sanctioned" and "could not
   read" apart (a tri-state return or a throwing variant, your choice). `backend/src/wot.ts` keeps
   refusing the auto-accreditation on a failed read.
2. The HTTP callers answer a 503 with `details.retriable: true` on "could not read", broadcast
   nothing, and keep 403 `ACCREDITATION_SANCTIONED` for a real sanction:
   - `broadcastAccreditationAndSeed` in `backend/src/routes/signup-verify.ts` (`POST /api/auth/confirm`,
     `POST /api/auth/link`);
   - `POST /api/accreditation/verify` in `backend/src/routes/accreditation.ts`;
   - the ORCID callback in `backend/src/routes/orcid.ts`;
   - `PATCH /api/accreditation/metadata` in `backend/src/routes/accreditation-metadata.ts`.
3. Rewrite or delete the accepted-tradeoff comment in `accreditation-metadata.ts` so it says what
   the handler then does. The `getAccreditedSet` safe-fail it also names is out of scope here (see
   below).
4. Comments follow root `CLAUDE.md` "Comment anchors".

## SPA consumers

Each route's SPA consumer must show an error with a retry for the 503. Known today: the verify page
routes `details.retriable: true` to its retry state (`_isRetriable` in
`frontend/src/pages/accreditation-verify.js`); on `/confirm` and `/link` the signup-verify page
falls to its generic failure, where submitting again retries. Check the ORCID callback page and the
metadata edit consumer (`frontend/src/api.js` `/accreditation/metadata`) and name any that offer no
retry in the signal block, for a ui task.

## Out of scope

- Other HAF reads that substitute an answer on failure, `getAccreditedSet`'s empty set among them:
  `architect-haf-outage-sweep`.

## Acceptance criteria

1. With the HAF pool absent, or the sanction query failing, each of the five endpoints answers a
   503 with `details.retriable: true` and broadcasts nothing.
2. A real sanction still answers 403 `ACCREDITATION_SANCTIONED` on each.
3. The wot path still refuses on a failed read.
4. After the 503 on `/confirm` and on `/link`, submitting again once HAF answers finalizes the
   accreditation and issues the session.
5. Tests on the real app database and real HAF; the failure path may mock the HAF pool under the
   root `CLAUDE.md` carve-out, with the header justification.

## [TODO Architect] at archive

- The 503 on each endpoint in `api-contracts/auth.md`, `api-contracts/accreditation.md` and
  `api-contracts/orcid.md`, and in `common.md`'s list of `details.retriable` emitters.

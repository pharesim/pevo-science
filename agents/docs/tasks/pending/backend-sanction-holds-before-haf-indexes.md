# A sanction holds from its broadcast, not from HAF indexing

**Owner:** backend
**Created:** 2026-10-08
**Priority:** high

Filed from the architect intake review of `backend-verify-gate-treats-wot-enrollee-as-accredited`
(security finding, confirmed by the validator). Incidence was not measured.

## Why

`ARCHITECTURE.md` § 2 "Sanctions are sticky": only a deliberate admin `accredit` lifts a sanction,
and every self-service accredit path must refuse a sanctioned account. Those paths enforce it with
`hasUnliftedSanction` (`backend/src/accreditation.ts`), which reads only HAF.
`POST /api/admin/accreditation/sanction` (`routes/admin.ts`) broadcasts the `type: "sanction"`
revoke and writes nothing a self-service path can read before HAF indexes it.

In that window, a self-service path passes the guard and broadcasts an authority accredit that
lands in a later block than the sanction. The window lasts as long as HAF lags the chain;
`HAF_INDEXING_LAG_CEILING_SECONDS` (`lib/orcid-binding.ts`, 120) is the lag ceiling the code
already assumes. Once both ops are indexed,
`hasUnliftedSanction` and the membership SQL count the accredit as later than the sanction, so the
account is no longer sanctioned. A member who expects a sanction can do this on purpose: hold a
pending accreditation token and call `/verify` as soon as the revoke appears on chain.

The validator found the window on:

- `POST /api/accreditation/verify`, for an account whose latest op is a revoke or a `wot`
  accredit, or that has none. The `wot` case is new since `31994b09`.
- `PATCH /api/accreditation/metadata`, which re-broadcasts the prior op's `method`, for a member
  whose prior op is not `wot`.
- ORCID `handleAccredit` (`routes/orcid.ts`), for a member outside the accredited set.

Signup-verify and the WoT auto-accredit call the same guard. `handleLink` calls no sanction guard
at all; scope item 4 of `backend-orcid-binding-sanction-sticky` adds it.

## Scope

The approach below is intent only. Verify it against the code before building on it.

1. Before broadcasting the sanction, the sanction route records an in-flight sanction for the
   account that outlives HAF indexing, for example a Redis key under `${config.appTag}:` with a TTL
   of `HAF_INDEXING_LAG_CEILING_SECONDS`. Keep it when the broadcast succeeds or its outcome is
   unknown (a timeout). Remove it only when the node definitely refused the op.
2. `hasUnliftedSanction` returns true while that record exists. A failed read of the record also
   returns true, as a HAF error already does.
3. `POST /api/admin/accreditation/grant` does not call `hasUnliftedSanction`, so the deliberate
   lift stays immediate. Keep it that way.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## Out of scope

- `handleLink`'s missing sanction guard (`backend-orcid-binding-sanction-sticky`).

## Acceptance criteria

1. With the in-flight record present and no sanction indexed, `/verify` for an account whose
   latest op is a `wot` accredit answers 403 `ACCREDITATION_SANCTIONED` and broadcasts nothing.
   `PATCH /api/accreditation/metadata` refuses the same way.
2. A failed read of the record makes `hasUnliftedSanction` return true.
3. A sanction broadcast that the node refuses leaves no record.
4. The broadcast is mocked under the root `CLAUDE.md` carve-out; the record store and the guard
   run for real.

## [TODO Architect] at archive

- `ARCHITECTURE.md` § 2 "Sanctions are sticky": say that a sanction holds from its broadcast.

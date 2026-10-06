# The registration watch posts full e-mail addresses to the Discord webhook

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Found while grounding `architect-accreditation-mailbox-binding-design`. Triage: user, "as
recommended".

## Why

`backend/src/jobs/registration-watch.ts` posts registration notices to the webhook configured by
`DISCORD_REGISTRATION_WEBHOOK_URL`; `.env.example` says "Payloads contain full email addresses".
That sends personal data of every signup to a third-party service that the privacy task's
outbound-services inventory does not list, for an operator convenience that the masked form
serves as well.

## Scope

1. Post the masked address (`maskEmail` in `backend/src/lib/log-pii.ts`, as the `/request`
   response already does) and the domain, never the full address.
2. The Gmail-family canonical fold (`CANONICAL_MAILBOX_SQL`) that counts siblings keeps working
   on the stored addresses; only the outbound payload changes.
3. `.env.example` wording is architect-zone; the architect updates it at archive.

## Acceptance criteria

1. The webhook payload for a registration contains no full address (unit test on the payload
   builder).
2. The sibling count is unchanged.

## [TODO Architect] at archive

- `.env.example`: the "Payloads contain full email addresses" sentence; the privacy task's
  outbound-services inventory lists the webhook with the masked payload.

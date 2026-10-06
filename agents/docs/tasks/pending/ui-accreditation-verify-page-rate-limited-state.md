# The verify page offers "Request New" on a 429 while the link still works

**Owner:** ui
**Created:** 2026-10-06
**Priority:** normal

Filed from the review of `backend-accreditation-verify-requires-the-account-session` (named in
its "Out of scope, for filing" list; the api-contract reviewer traced it).

## Why

`POST /api/accreditation/verify` answers 429 `RATE_LIMITED` after 5 calls per minute from one
account. The 429 carries no `details.retriable`, so `_isRetriable` in
`frontend/src/pages/accreditation-verify.js` is false and the page lands in the `error` state,
whose primary button is "Request New" (`verify.requestNew`). The link is still valid. A new
request costs one of the account's 3 requests per 24 hours.

## Scope

1. Map `RATE_LIMITED` on this page to a state that tells the user to wait and retry the same
   link, with no "Request New". The `retriable_error` state with its cooldown is the nearest
   existing state. Intent only: write the copy against what the user can do.

## Acceptance criteria

1. A 429 from `/verify` shows no "Request New", and the retry after the wait posts the same token.
2. Every other `/verify` outcome lands in the state it lands in today.
3. No emdash in new UI copy.

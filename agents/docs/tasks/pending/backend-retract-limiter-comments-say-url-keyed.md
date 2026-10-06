# Two papers.ts comments call the retract limiter URL-keyed; it is keyed by account

**Owner:** backend
**Created:** 2026-10-06
**Priority:** low

Filed from the review of `backend-accreditation-verify-requires-the-account-session` (named in
its "Out of scope, for filing" list; verified against the code).

## Why

In `backend/src/routes/papers.ts`, `retractLimiter` is `rateLimit({ name: 'paper-retract', ...,
keyFn: byAccount, ... })`. Two comments say otherwise:

- the `validateRetractParams` JSDoc: "The route is URL-keyed (the target is the slug pair, not the
  authenticated principal), so it differs from the body-shape validators on ...";
- the comment on the `/:author/:permlink/retract` route: "this route's limiter is URL-keyed".

## Scope

1. Delete or narrow the URL-keyed claims (root `CLAUDE.md` "Comment anchors": delete or narrow,
   do not rewrite longer). The reason the validator runs before `verifyHiveSignature`, rejecting a
   malformed slug without paying ECDSA recovery, still holds and can stay.

## Acceptance criteria

1. The diff changes comments only.
2. `backend/tests/eslint/` run alone is green; give the result in the signal block.

# Retract comments call the limiter URL-keyed; it is keyed by account

**Owner:** backend
**Created:** 2026-10-06
**Priority:** low

Filed from the review of `backend-accreditation-verify-requires-the-account-session` (named in
its "Out of scope, for filing" list; verified against the code). Widened at its archive by the
solutions refresh that replaced the limiter-ordering entry.

## Why

In `backend/src/routes/papers.ts`, `retractLimiter` is `rateLimit({ name: 'paper-retract', ...,
keyFn: byAccount, ... })`. Four comments say otherwise or overclaim:

- the `validateRetractParams` JSDoc: "The route is URL-keyed (the target is the slug pair, not the
  authenticated principal), so it differs from the body-shape validators on ...";
- the same JSDoc: the custody validators run where "the validator must run AFTER
  `verifyHiveSignature` to attribute the error to an authenticated user". Those validators read
  only `req.body`; attribution is a reason to place them there, not a requirement;
- the comment on the `/:author/:permlink/retract` route: "this route's limiter is URL-keyed";
- `backend/tests/routes/papers-retract-url-shape-validator.test.ts`, in the spec that sends a
  malformed slug with no auth headers: "URL-keyed route".

The rule the code supports is in
`agents/docs/solutions/conventions/account-keyed-limiter-after-auth-validator-before-limiter.md`.

## Scope

1. Delete or narrow these claims (root `CLAUDE.md` "Comment anchors": delete or narrow, do not
   rewrite longer). The reason the validator runs before `verifyHiveSignature`, rejecting a
   malformed slug without paying for the auth check, still holds and can stay.

## Acceptance criteria

1. The diff changes comments only.
2. `backend/tests/eslint/` run alone is green; give the result in the signal block.

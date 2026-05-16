# BACKEND-VERIFYHIVE-AUTHMETHOD-DISCRIMINATOR — Expose `req.hiveAuthMethod` on the auth middleware

**Owner:** Backend Agent
**Created:** 2026-05-16 (backend, surfaced by `backend-settings-email-reauth-fresh-auth.md` round-1 implementation)
**Priority:** P3

## Problem

`backend/src/middleware/verifyHiveSignature.ts` is a unified Bearer-JWT + Hive-Signature middleware. The two paths produce identical `req.hiveUsername` and `req.hiveCustody` outputs; route handlers cannot distinguish "was this request authenticated via a JWT (replayable bearer token) or a per-request Hive signature (fresh-proof-bound)?" without re-parsing `req.headers['authorization']` themselves.

Today's call sites that need the discrimination (e.g., `backend/src/routes/settings.ts` POST `/email`, where the JWT path requires a body `fresh_auth_proof` and the Hive-signature path does not) duplicate the same `authHeader?.startsWith('Bearer ')` check inline. Each duplication is a chance to drift — a refactor that moves the JWT-vs-signature decision into the middleware (e.g., to add a third auth path, or to swap one of them out) doesn't get reflected at the route layer.

The settings-email-reauth-fresh-auth task body called this out explicitly:

> Distinguish JWT path from Keychain path by checking whether `req.headers['authorization']?.startsWith('Bearer ')` succeeded (already the discriminator inside `verifyHiveSignature`); a cleaner approach is to expose this via a `req.hiveAuthMethod: 'jwt' | 'signature'` field on the middleware so route handlers don't re-parse headers. If adding that field is non-trivial, use the existing `req.hiveCustody` plus header re-check as a near-term path and file a small follow-up to add the explicit discriminator.

Round 1 of the email task took the header re-check path to avoid colliding with another in-flight worker editing `verifyHiveSignature.ts`. This task is the deferred-explicit-discriminator follow-up.

## Goal

Add a `req.hiveAuthMethod: 'jwt' | 'signature'` field to the Express `Request` namespace augmentation in `verifyHiveSignature.ts`. Populate it from the JWT-path branch (`'jwt'`) and the Hive-signature-path branch (`'signature'`). Migrate the existing `req.headers['authorization']?.startsWith('Bearer ')` re-checks at route call sites to consume the new field.

## Acceptance

1. `req.hiveAuthMethod` is set to `'jwt'` on the JWT-success branch of `verifyHiveSignature` (after `jwt.verify` succeeds and before `next()`).
2. `req.hiveAuthMethod` is set to `'signature'` on the Hive-signature-success branch (after signature recovery + posting-key match).
3. Failures (401 returns) leave the field unset (the request never reaches a downstream handler in this case, but the contract is "set on success only").
4. The Express namespace augmentation in `verifyHiveSignature.ts` declares the field with the union type `'jwt' | 'signature'`.
5. `routes/settings.ts` POST `/email` migrates from `const isJwtPath = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')` to `const isJwtPath = req.hiveAuthMethod === 'jwt'`. Any other call sites discovered in a repo-wide grep for `authorization`-startsWith-Bearer patterns INSIDE route handlers (not in middleware) migrate too.
6. A real-path integration test (in `backend/tests/middleware/`) exercises both branches and asserts the field is set correctly. A separate test asserts the field is consumed correctly at one downstream route (extend `tests/routes/settings-email-fresh-auth.test.ts` or add a similar fixture).

## Out of scope

- Changing the auth model itself (no new auth paths, no removal of JWT support).
- Type-checking that handlers DON'T forget to read the field. A runtime invariant or a lint rule would over-engineer; the migration in acceptance #5 is the audit point.

## References

- `backend/src/middleware/verifyHiveSignature.ts:79` (JWT-path branch where the field would be set to `'jwt'`)
- `backend/src/middleware/verifyHiveSignature.ts:181` (Hive-signature-path branch where the field would be set to `'signature'`)
- `backend/src/routes/settings.ts` POST `/email` (the first consumer; the round-1 commit of `backend-settings-email-reauth-fresh-auth.md` left a TODO referencing this task)
- `backend/src/lib/fresh-auth.ts` (downstream consumer of the JWT-vs-signature decision; the body-proof gate is required only on the JWT path)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

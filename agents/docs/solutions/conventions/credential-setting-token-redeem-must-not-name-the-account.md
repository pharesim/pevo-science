---
title: The password reset answers the browser's session question by bearer match, never by naming the account
date: 2026-10-07
category: conventions
module: backend/src/routes
problem_type: convention
component: authentication
severity: high
applies_when:
  - Changing the response of `POST /api/auth/reset`, which redeems the single-use token a mailed link carried and sets a new password
  - The SPA needs to know whether the session it holds belongs to the account the reset acted on
  - Reviewing a proposal to add a username, email or other account identifier to the reset response
tags:
  - account-identifier-disclosure
  - mailed-link-token
  - password-reset
  - bearer-match
  - session-revocation
  - threat-model
---

# The password reset answers the browser's session question by bearer match, never by naming the account

## Context

`POST /api/auth/reset` revokes every session of the account whose token it redeems. A browser that is signed in to that account when its user completes the reset keeps the dead token until its next bearer request, which then tears every tab down with the signed-out message, minutes later and unprompted. To end that session at the moment of the reset, and only when it belongs to the reset account, the SPA has to know which account was reset.

The first answer was to add `data.username` to the reset response. It was recommended for determinism ("the comparison is then direct") against a client-side probe of the stored session (session history). Nobody asked who else can hold a reset token. A read-only check of every token leak path, followed by a skeptic pass that could not refute it, showed that the field turns some leaks from a lockout into a sign-in. The user chose a bearer-scoped boolean instead.

## Guidance

- Never echo the account (username, email, row id) in the `POST /api/auth/reset` response.
- When the browser needs to know whether its own session is the affected account, let it send that session token as an optional `Authorization: Bearer` header and answer a boolean. The bearer is evidence the caller already holds; the answer adds nothing a token-only caller can use.
- The bearer must never gate the redeem. A missing, foreign, forged or malformed bearer answers `false`, and the redeem lands exactly as it would without one.
- Compare against the account the write actually touched (`UPDATE ... RETURNING username`), not a value read before the write.

PEvO's implementation is `bearerNamesAccount` in `backend/src/routes/auth.ts`. It makes the same `jwt.verify(token, config.sessionSecret)` call as `verifyHiveSignature`'s JWT branch, without that branch's revocation read (the reset has just revoked every session of the account, so a stored token for it is dead either way), and compares the verified `sub` with the username the reset's UPDATE returned:

```ts
function bearerNamesAccount(req: Request, username: string | null): boolean {
  const authHeader = req.headers['authorization'];
  if (!username || !authHeader?.startsWith('Bearer ')) return false;
  try {
    const payload = jwt.verify(authHeader.slice(7), config.sessionSecret) as { sub?: unknown };
    return payload.sub === username;
  } catch {
    return false;
  }
}
```

The success answer is `{ message, session_ended }`.

## Why This Matters

`POST /api/auth/login` matches its identifier against either column (`WHERE a.username = $1 OR a.email = $1` in `backend/src/routes/auth.ts`). Whether an identifier in the reset response matters therefore depends on who holds the token:

- **Parties that see the mail** (the mailbox, its relay and providers, link scanners) also see the `To:` address, which already works as a login identifier. The field gives them nothing.
- **Parties that hold the token without the mail** get the identifier from nowhere else. Paths found: the access log (`httpLogger` in `backend/src/logger.ts` serializes `req.url` with its query string, so opening the link logs the token), the external reverse proxy's log, and browser history, sync, extensions and URL-reputation services. Without the identifier, such a party can redeem the token but only locks the owner out of an account it cannot name. With it, the same request yields a working (username, password) pair.

For a light account (ARCHITECTURE.md § 6.1 states A and B) a session plus the password the attacker just set yields a password fresh-auth proof, which unlocks server-side broadcast as the user, an email change and data deletion. The seed-phrase-gated custody upgrade keeps owner and active keys safe, and D and G rows get only a `'self'` claim, but the A/B case alone makes the field a takeover path.

Two leak paths are closed in code and need no answer here: helmet's default `Referrer-Policy: no-referrer` applies (`backend/src/app.ts` passes no `referrerPolicy` override), and mail link scanners only issue GETs, while the redeem is a POST.

## When to Apply

- Changing what `POST /api/auth/reset` tells the browser about the account it touched.
- Deciding between a backend-named field and a client-side probe: the bearer match is a third option that keeps the comparison deterministic and discloses nothing.

## Examples

Before (as first filed), the response names the account to whoever redeems the token:

```ts
sendOk(res, { message: 'Password has been reset. Please log in with your new password.', username: account.username });
```

After, the response answers only the caller's own question:

```ts
const { username } = updated.rows[0]; // from UPDATE ... RETURNING username
sendOk(res, {
  message: 'Password has been reset. Please log in with your new password.',
  session_ended: bearerNamesAccount(req, username),
});
```

Tests that pin it: `backend/tests/routes/auth-reset-session-match.test.ts` covers a bearer for the reset account (true), for another account, signed with another secret, and not a JWT (each false, with the password still rotated). `backend/tests/routes/auth-reset-account-state.test.ts` asserts the whole success `data` object for every resettable account state, so an identifier added to the response fails it.

## Related

- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`: the sibling rule on the same email flow, that `/reset-request` must not distinguish a known from an unknown address by status code.
- `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md`: the identity-disclosure family for auth endpoints.
- `agents/docs/solutions/conventions/recovery-defenses-vs-seed-phrase-holder-non-load-bearing-2026-05-25.md`: its dismissal of response-shape findings against a seed-phrase holder does not extend to a token-only holder of a reset link.
- `agents/docs/solutions/conventions/optional-predicate-gate-needs-live-false-case-not-just-absent-2026-09-02.md`: why the tests send a live foreign and a forged bearer, not only none.

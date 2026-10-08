---
title: "A caller that skips the fresh-auth proof for a custody is only right if every request it reaches carries that custody's own credential: pin the transport per custody at the request layer"
date: 2026-10-08
category: conventions
module: frontend/src/lib/settings-fresh-auth.js + frontend/src/api.js
problem_type: convention
component: authentication
severity: high
root_cause: incomplete_enumeration
resolution_type: code_fix
applies_when:
  - "An orchestrator or wrapper skips minting a fresh-auth body proof for one custody on the premise that the request will prove itself another way (a Keychain signature)"
  - "Adding a new critical-action API function that an existing proof-skipping orchestrator will call through a run callback"
  - "A request function sends a bearer through authenticatedRequest while its docblock says the Keychain path needs no proof"
  - "Unit tests pin the orchestrator's skip and the request function's wire shape in separate suites, with test auth stores that carry no custody"
  - "Reviewing a report that self-custody sessions fail every settings or admin critical action with 401"
symptoms:
  - "Every settings critical action fails for every self-custody ('self' claim) session with 401 FRESH_AUTH_REQUIRED, or 401 UNAUTHORIZED on the no-row add-email branch"
  - "The SPA shows only the handler's generic failure copy; no Keychain prompt ever opens"
  - "Both halves are green in isolation: the orchestrator test pins 'self-custody calls run with no proof', and the API tests pin a bearer request shape"
related_components:
  - frontend_stimulus
  - testing_framework
tags:
  - fresh-auth
  - self-custody
  - keychain
  - signature-path
  - bearer
  - custody-split
  - settings
  - verifyhivesignature
---

# A caller that skips the fresh-auth proof for a custody is only right if every request it reaches carries that custody's own credential

## Context

`withSettingsFreshAuth` (`frontend/src/lib/settings-fresh-auth.js`) runs the settings critical actions: change, add or re-issue email, delete account, set password, and the accreditation metadata edit. For a light session it mints a single-use `fresh_auth_proof` and threads it into the action's `run(proof)` callback. For any other custody it skipped the mint and called `run(undefined)`, on the premise its comment stated: "the per-request signature is itself the fresh proof".

The premise held for the admin console, whose run callbacks go through `adminMutation` (`frontend/src/api.js`), and for the upload pre-flight in `uploadFileToIpfs`. Both split on custody and sign with `signRequest` for a self-custody session. It did not hold for the settings callbacks. `submitEmail`, `deleteEmail`, `setPassword` and `submitAccreditationMetadata` all went through `authenticatedRequest`, which always sends the session bearer and never signs.

`verifyHiveSignature` (`backend/src/middleware/verifyHiveSignature.ts`) checks a bearer before the `X-Hive-*` signature headers and sets `req.hiveAuthMethod = 'jwt'` when it verifies. So every self-custody settings request took the JWT path with no body proof and was refused: 401 `FRESH_AUTH_REQUIRED` on an existing row, and 401 `UNAUTHORIZED` on the no-row add branch, which refuses the JWT path outright. The password issuer could not help: `POST /api/custody/fresh-auth` refuses every non-light claim with 403 (`refuseNonLight` in `backend/src/routes/custody.ts`), and the orchestrator never offered a non-light session the ORCID factor. Password, ORCID and Keychain logins all mint the same `{sub, custody: 'self'}` claim, so the failure covered every self-custody session in every account state. A real-backend reproduction confirmed it for no-row Keychain users, state G (verified and unverified) and state D by each login factor.

Nothing caught it because each half was tested where it lived. `lib-settings-fresh-auth.test.js` pins "self-custody calls run with no proof and mints nothing", a correct statement about the skip. `api.test.js` ran `submitEmail`, `deleteEmail` and `setPassword` on the bearer path with an auth store that carries no custody, asserting their bodies (and, for `setPassword`, the bearer header), a correct statement about the light path. No test asserted what a self-custody session actually sends.

## Guidance

1. **A skip in the caller is a claim about the callees.** When an orchestrator skips a credential for a custody, enumerate every `run` callback it can reach and confirm each one transmits that custody's own credential. For PEvO's self-custody sessions that means a Keychain signature on a request with no `Authorization` header.

2. **Put the custody split in the request function, and pin it there per custody.** The settings functions now share `settingsActionRequest` (`frontend/src/api.js`). For `custody === 'self'` it signs the full `/api/...` path with `signRequest` and sends the signed body through plain `request()`. For any other custody it sends the bearer with the caller's proof:

   ```js
   async function settingsActionRequest(path, method, body) {
     const auth = Alpine.store('auth');
     if (auth?.custody === 'self') {
       const signed = await signRequest(auth.username, method, `${BASE_URL}${path}`, body);
       return request(path, {
         method,
         headers: { 'Content-Type': 'application/json', ...signed.headers },
         body: signed.body,
       });
     }
     return authenticatedRequest(path, {
       method,
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(body),
     });
   }
   ```

   The tests that prove it set `custody: 'self'` on the auth store and assert the wire: no `Authorization`, `X-Hive-Signature` present, the signed path equal to the request path, the method, `Content-Type`, and the exact body (`describe('settings critical actions: custody dispatch')` in `frontend/tests/unit/api.test.js`).

3. **A signed request must not also carry the bearer.** Adding signature headers to an `authenticatedRequest` call does not help: with a live bearer, `verifyHiveSignature` never reads the `X-Hive-*` headers. Send signed requests through `request()`, as `adminMutation`, `uploadFileToIpfs` and `linkExistingAccount` do.

4. **Check whether the route accepts the signature as the proof at all.** Signing is the fresh proof only where the handler branches on `req.hiveAuthMethod`. `POST /api/settings/set-password` does not: it consumes an ORCID-mechanism proof on every auth path, so a signed request without one still gets 401. The orchestrator's skip therefore exempts `set_password` (`ctx.custody !== 'light' && action !== 'set_password'`), and a self-custody session takes the same ORCID round-trip light accounts use. `setPassword` stays on the bearer path carrying that proof.

5. **Key the split on the custody value that signs.** Tests that model the light path often build an auth store with no custody. Key the signing branch on `=== 'self'` (the `uploadFileToIpfs` form) so those stay on the bearer path. A `!== 'light'` key (the `adminMutation` form) would route them to `signRequest`. A connected store only holds `'light'` or `'self'`, so the two forms differ only in tests and in the disconnected state.

## Why This Matters

The failure was total for one population and silent in the suite: every self-custody account was locked out of email changes, account deletion, setting a first password and its own profile edit, and the UI said only "try again". A credential-skipping branch with a comment explaining why it is safe reads as reviewed. The comment named a mechanism, the per-request signature, that existed in the codebase but not on these calls. Pinning the transport per custody at the request layer is what makes the skip's premise checkable by a test that fails.

Review alone did not catch it. Several earlier reviews of these same files, a multi-agent review among them, read both the orchestrator and the bearer path in `api.js` while scoped on light-account session behaviour, and none exercised a self-custody settings request. An earlier self-custody upload branch showed the same shape: fresh-auth work built around light accounts left the Keychain branch untested until a test was written for it (session history).

## When to Apply

- Adding a critical-action function to `api.js` that `withSettingsFreshAuth`, `withAuthorshipFreshAuth` or `broadcastWithFreshAuth` will call for a non-light session.
- Changing what a self-custody session's request carries, or moving a function between `authenticatedRequest` and `request()`.
- Reviewing a test pair where one suite pins "no proof for self-custody" and another pins the request shape without setting a custody.
- Adding a backend critical action: decide whether its handler accepts the signature as the proof, and if not, make sure the frontend skip exempts it.

## Examples

Before, the orchestrator skipped the proof for self-custody, and the callee sent a bearer:

```js
// settings-fresh-auth.js: withSettingsFreshAuth
if (ctx.custody !== 'light') {
  return { ok: await run(undefined) };
}

// api.js
export function submitEmail(email, freshAuthProof) {
  return authenticatedRequest('/settings/email', { method: 'POST', /* ... */ });
}
```

On the wire: `Authorization: Bearer <jwt>`, no `X-Hive-*` headers, no `fresh_auth_proof`. The result is 401.

After: `submitEmail`, `deleteEmail` and `submitAccreditationMetadata` go through `settingsActionRequest`, and the orchestrator exempts the one action whose handler wants a proof on every path:

```js
if (ctx.custody !== 'light' && action !== 'set_password') {
  return { ok: await run(undefined) };
}
```

On the wire for a self-custody change-email: `X-Hive-Username`, `X-Hive-Signature` and `X-Hive-Timestamp`, no `Authorization`, and the body exactly as signed. The signed message is `<appTag>-auth|v1|POST|/api/settings/email|<sha256(body)>|<timestamp>`, the form `buildCanonicalAuthMessage` rebuilds on the backend.

## Related

- `fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md`: the same sweep-the-callee-graph discipline, for teardown guards.
- `admin-account-locked-by-hive-create-claimed-account-semantics-2026-05-19.md`: the backend `requireFreshAdminAuth` split and its frontend mirror in `adminMutation`, the correct precedent the settings path lacked.
- `hive-signature-request-binding-shape-2026-04-21.md`: the signed message shape `signRequest` produces and `verifyHiveSignature` checks, and that the bearer path runs first.
- `test-fabricated-error-shape-masks-dead-branch-2026-06-09.md` and `defensive-gate-co-land-unblocking-surface-2026-05-16.md`: other settings fresh-auth paths that were dead in production while their tests stayed green.
- `account-state-fixture-must-satisfy-all-dimensions-2026-06-09.md`: a fixture that omits one state dimension (there, `orcid`) passes green through a partial discriminator.

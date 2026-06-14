---
title: PEvO admin-account JWT-bypass on critical actions is structurally impossible under Hive's create_claimed_account semantics — dismiss this finding when the admin route gates on config.hiveAdminAccount equality alone
date: 2026-05-19
category: conventions
module: backend/src/routes
problem_type: convention
component: authentication
severity: medium
applies_when:
  - Triaging an adversarial-lens or security-lens code-review finding that flags an admin endpoint's `verifyHiveSignature` JWT path as a potential ARCHITECTURE.md § 6.5 invariant #1 violation
  - Reviewing any current or future route under `backend/src/routes/admin.ts` (or any route gated on `req.hiveUsername === config.hiveAdminAccount`)
  - Designing a new admin-zoned critical action and wondering whether to enforce `req.hiveAuthMethod === 'signature'` explicitly
  - Landing a new admin-management surface (DB-backed admin role, in-product elevation, etc.) — this convention's protection dissolves at that point and the JWT-path concern re-opens
tags:
  - admin
  - security
  - re-auth
  - jwt
  - hive-account-semantics
  - dismissal-rationale
---

## Context

The first admin-zoned route in PEvO is `POST /api/admin/accreditation/reset-broadcast-counter` (`backend/src/routes/admin.ts`, surfaced by `backend-verify-cap-redis-flap-recovery` round-1 review 2026-05-18). It authenticates via the unified `verifyHiveSignature` middleware, which accepts BOTH JWT-Bearer and Hive-signature paths. The handler then gates on:

```ts
const username = req.hiveUsername!;
if (username !== config.hiveAdminAccount) {
  return sendError(res, 403, 'FORBIDDEN', /* ... */);
}
// proceed with the counter-reset critical action
```

An adversarial-style or security-lens review correctly identifies this shape as a potential violation of `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1: *"A stolen JWT must not be a one-step takeover vector. JWT-only access on a critical action is a defect."* If the admin account were registered as a light account in PEvO, a stolen admin JWT could trigger a critical-action reset without a fresh Hive signature — exactly the failure mode the invariant guards against.

This convention captures the structural protection that makes the finding dismissable today, so every subsequent review of an admin-zoned route doesn't re-discover and re-dismiss the same concern.

## Scope update (2026-06-15): the re-opening trigger fired — dismissal now scoped to the singular-signer equality gate

The admin-console roster work (`backend/src/routes/admin.ts` roster + authority routes, `backend/src/admin-roster.ts`, frontend `pages/admin.js` + `api.js` `adminMutation`) landed the exact admin-management surface Example 2 below predicted. PEvO now has TWO distinct admin authorization shapes, and this convention applies to only one of them:

1. **Singular-signer equality gate** — `req.hiveUsername === config.hiveAdminAccount` (the `POST /api/admin/accreditation/reset-broadcast-counter` route, and the `isAdmin === config.hiveAdminAccount` checks in `claims.ts` / `papers.ts`). The structural `create_claimed_account` lock STILL holds here: the singular admin account is on-chain by definition and can never be registered as a PEvO light account, so its JWT path is unreachable. **The dismissal below still applies to these routes.**

2. **Chain-derived multi-admin roster gate** — `requireAdminLevel(<min>)` against the live `active_admins` roster (the roster-management and authority routes). Roster members are arbitrary accounts (`admin` / `super_admin`), some of which ARE light accounts holding PEvO-minted JWTs. The structural lock does NOT protect these — exactly the re-opening Example 2 named. They are instead defended mechanically by `requireFreshAdminAuth(<action>)` (`backend/src/admin-roster.ts`): a JWT caller (`hiveAuthMethod === 'jwt'`) must carry a single-use `fresh_auth_proof`; a self-custody caller (`hiveAuthMethod === 'signature'`) is fresh by construction. **Do NOT dismiss a JWT-path finding on a roster-gated route via this convention — instead verify the `requireFreshAdminAuth` gate is present and correctly ordered (`verifyHiveSignature → requireAdminLevel → validate → requireFreshAdminAuth`).** Per ARCHITECTURE.md §6.8, every admin authority action is a §6.4 critical action.

The dismissal rationale that follows is therefore correct for shape (1) and actively wrong for shape (2).

## Guidance

When an adversarial or security review flags an admin route's JWT-path acceptance as a § 6.5 invariant #1 risk, **dismiss the finding** if all four conditions hold:

1. The route gates on `req.hiveUsername === config.hiveAdminAccount` equality.
2. `config.hiveAdminAccount` is set via the `HIVE_ADMIN_ACCOUNT` env var (an existing on-chain Hive account name; default `pevo.admin`).
3. The route authorizes via `req.hiveUsername === config.hiveAdminAccount` equality (the singular signer) — NOT via the chain-derived `requireAdminLevel` roster gate. (As of 2026-06-15 the roster gate exists; routes behind it are defended by `requireFreshAdminAuth`, not by this structural lock — see "Scope update" above. This condition is what scopes the dismissal to the singular-signer routes.)
4. The PEvO `/api/auth/signup` flow remains the only path that mints a PEvO JWT, and that flow uses Hive `create_claimed_account` to register NEW Hive accounts.

The structural protection: Hive's `create_claimed_account` operation REJECTS any account name that already exists on-chain. The admin account (`pevo.admin` or whichever account `HIVE_ADMIN_ACCOUNT` names in production) is already on-chain by definition — that's the whole point of running PEvO. Therefore PEvO's signup flow cannot register the admin account as a light account, cannot mint a JWT with `sub === <admin-account>`, and the JWT path through `verifyHiveSignature` for the admin's username is structurally unreachable.

Document the dismissal in the task file's "Items dismissed during architect triage" block citing this convention — do not require the implementer to add a `req.hiveAuthMethod === 'signature'` enforcement at the route layer. The mechanical defense is unnecessary while the four conditions hold.

## Why This Matters

Without this convention written down, every future security-lens or adversarial-lens code review of an admin route surfaces the same finding (JWT-bearer path accepts a stolen admin JWT → § 6.5 invariant #1 violation). The dismissal rationale lives in **Hive's account-creation semantics**, NOT in PEvO's code, NOT in PEvO's deployment configuration, NOT in `ARCHITECTURE.md`. A reviewer doing their job correctly cannot reconstruct this protection from reading PEvO source.

The cluster-B triage already encountered this once. The security reviewer's residual #1 said *"revisit if the admin account ever becomes a light account"* — correct framing but missed the structural impossibility of that condition under Hive's account-creation semantics. The architect verified during triage that Hive itself rejects the signup attempt for an existing account name; the dismissal stuck. Without this convention, every subsequent review of an admin route will do the same dance.

This convention is also load-bearing for the architect's "do NOT require `req.hiveAuthMethod === 'signature'` enforcement on admin routes" decision. The `req.hiveAuthMethod` discriminator field exists (landed by `backend-verifyhive-authmethod-discriminator` task) and would be a mechanically simple defense to enforce. The reason it's NOT enforced is the structural lock — and the reason the structural lock isn't visible in the route source is that it lives in Hive's protocol layer.

## When to Apply

Apply when:

- Triaging a `/ce-code-review` finding (any persona — security, adversarial, correctness, project-standards) that names the admin endpoint's JWT path as a § 6.5 invariant #1 risk.
- Reviewing a NEW admin-zoned route added to `backend/src/routes/admin.ts` (or anywhere else gated on `req.hiveUsername === config.hiveAdminAccount`).
- Considering whether to enforce `req.hiveAuthMethod === 'signature'` at an admin route's handler entry.

Do NOT apply when:

- The route is gated by the chain-derived `requireAdminLevel` roster (as of 2026-06-15, the roster-management and authority routes in `backend/src/routes/admin.ts`). The structural lock does not protect roster members who hold PEvO-minted JWTs; those routes are defended by `requireFreshAdminAuth` instead. A JWT-path finding there is NOT dismissable via this convention — verify the `requireFreshAdminAuth` gate is present (see "Scope update" above). The convention was re-scoped rather than retired because the singular-signer equality gate (shape 1) still exists and still benefits from the structural-lock dismissal.
- The route gates on something other than `req.hiveUsername === config.hiveAdminAccount` equality (e.g., a future route that authorizes a broader set of accounts, or a route that defers to a different account-state check).

## Examples

**Example 1 — admin reset endpoint review (the canonical case):**

Reviewer finding: *"`admin.ts` accepts JWT-bearer auth on the reset-broadcast-counter route; a stolen admin JWT could trigger a critical-action reset without a fresh Hive signature. Per § 6.5 invariant #1, this is a defect — require `req.hiveAuthMethod === 'signature'`."*

Architect dismissal: *"Dismissed per `admin-account-locked-by-hive-create-claimed-account-semantics-2026-05-19.md`. The admin account is an existing on-chain Hive account; PEvO's signup flow uses `create_claimed_account` which rejects existing account names; PEvO has no admin-elevation route. The JWT-path concern is structurally unreachable under the current architecture."*

**Example 2 — re-opening trigger (fired 2026-06-14/15):**

The admin-console roster work landed `POST /api/admin/roster/grant` + `/revoke` (promote/demote against the chain-derived roster) and the authority routes (grant accreditation, sanction, retract paper, revoke/approve authorship). The configured admin can now elevate arbitrary accounts to `admin` / `super_admin`, some of which are light accounts holding PEvO-minted JWTs. Condition #3 no longer holds for these roster-gated routes, so the structural lock does NOT cover them.

This was handled correctly — not by retiring the convention, but by re-scoping it (this doc) and by the mechanical defense the implementer added: every roster-gated route chains `requireAdminLevel(<min>)` then `requireFreshAdminAuth(<action>)` (`backend/src/admin-roster.ts`). `requireFreshAdminAuth` rejects a JWT caller (`hiveAuthMethod === 'jwt'`) that lacks a single-use `fresh_auth_proof` with `401 FRESH_AUTH_REQUIRED`, and passes a self-custody caller (`hiveAuthMethod === 'signature'`) whose per-request signature is fresh by construction. The frontend mirrors the split in `api.js` `adminMutation` (light → JWT + body proof; self-custody → `signRequest`). So a stolen roster-member JWT alone cannot broadcast an authority op.

The `backend-verifyhive-authmethod-discriminator` task's `req.hiveAuthMethod` discriminator is what `requireFreshAdminAuth` keys on — landed exactly for this dissolution case.

## References

- `backend/src/admin-roster.ts` — `requireAdminLevel` (roster tier gate) and `requireFreshAdminAuth` (the mechanical fresh-auth defense for roster-gated routes; the post-2026-06-15 successor protection where the structural lock does not reach).
- `backend/src/routes/admin.ts` roster + authority routes and `frontend/src/api.js` `adminMutation` — the landed admin-management surface that fired Example 2's re-opening trigger.
- `backend/src/routes/admin.ts` — the canonical singular-signer admin route (`reset-broadcast-counter`) this convention covers.
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1 — "Critical actions require fresh re-auth proof. A stolen JWT must not be a one-step takeover vector."
- `agents/docs/tasks/pending/backend-verify-cap-redis-flap-recovery.md` round-1 → round-2 hold-block, "Items dismissed during architect triage" — the dismissal site that motivated this convention.
- `backend/src/middleware/verifyHiveSignature.ts` — the unified middleware accepting both JWT and Hive-signature paths.
- `backend-verifyhive-authmethod-discriminator` (review-archived task; surfaces `req.hiveAuthMethod` discriminator for the re-opening case).
- Hive protocol documentation for `create_claimed_account` (rejects existing account names by name uniqueness invariant; see https://developers.hive.io/).

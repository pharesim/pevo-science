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

## Guidance

When an adversarial or security review flags an admin route's JWT-path acceptance as a § 6.5 invariant #1 risk, **dismiss the finding** if all four conditions hold:

1. The route gates on `req.hiveUsername === config.hiveAdminAccount` equality.
2. `config.hiveAdminAccount` is set via the `HIVE_ADMIN_ACCOUNT` env var (an existing on-chain Hive account name; default `pevo.admin`).
3. PEvO has no admin-elevation route, no admin-management UI, and no DB column tracking admin status (verify via `grep -rn 'hiveAdminAccount\|isAdmin\|admin_role' backend/src/`).
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

- PEvO has landed an admin-management surface (a route that writes admin status to a DB column, or any route that lets a non-admin account become an admin without modifying `HIVE_ADMIN_ACCOUNT`). The four conditions above no longer hold, and the structural protection dissolves. Whoever lands that surface must explicitly enforce `req.hiveAuthMethod === 'signature'` on every admin route, and this convention's dismissal rationale becomes invalid — revisit the convention at that point and either retire it or re-scope it.
- The route gates on something other than `req.hiveUsername === config.hiveAdminAccount` equality (e.g., a future route that authorizes a broader set of accounts, or a route that defers to a different account-state check).

## Examples

**Example 1 — admin reset endpoint review (the canonical case):**

Reviewer finding: *"`admin.ts` accepts JWT-bearer auth on the reset-broadcast-counter route; a stolen admin JWT could trigger a critical-action reset without a fresh Hive signature. Per § 6.5 invariant #1, this is a defect — require `req.hiveAuthMethod === 'signature'`."*

Architect dismissal: *"Dismissed per `admin-account-locked-by-hive-create-claimed-account-semantics-2026-05-19.md`. The admin account is an existing on-chain Hive account; PEvO's signup flow uses `create_claimed_account` which rejects existing account names; PEvO has no admin-elevation route. The JWT-path concern is structurally unreachable under the current architecture."*

**Example 2 — re-opening trigger (hypothetical future):**

A future task lands `POST /api/admin/promote` that writes an `is_admin` column on the `accounts` table. The new route lets the configured admin grant admin status to any registered light account. The four dismissal conditions no longer hold: condition #3 ("PEvO has no admin-elevation route") is now false. A stolen JWT from any account granted admin status becomes a one-step takeover vector for every existing admin-zoned route.

At this point, the implementer of `/api/admin/promote` must:

- Retire or re-scope this convention (the structural lock is gone).
- Add `if (req.hiveAuthMethod !== 'signature') return sendError(res, 401, 'FRESH_AUTH_REQUIRED', ...)` to every admin-zoned route handler.
- Update `ARCHITECTURE.md` § 6.1 / § 6.5 if the admin-state introduction warrants a new enumerated account-state.

The `backend-verifyhive-authmethod-discriminator` task landed `req.hiveAuthMethod` specifically to enable this mechanical enforcement if and when the structural lock dissolves.

## References

- `backend/src/routes/admin.ts` — the canonical admin route this convention covers.
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1 — "Critical actions require fresh re-auth proof. A stolen JWT must not be a one-step takeover vector."
- `agents/docs/tasks/pending/backend-verify-cap-redis-flap-recovery.md` round-1 → round-2 hold-block, "Items dismissed during architect triage" — the dismissal site that motivated this convention.
- `backend/src/middleware/verifyHiveSignature.ts` — the unified middleware accepting both JWT and Hive-signature paths.
- `backend-verifyhive-authmethod-discriminator` (review-archived task; surfaces `req.hiveAuthMethod` discriminator for the re-opening case).
- Hive protocol documentation for `create_claimed_account` (rejects existing account names by name uniqueness invariant; see https://developers.hive.io/).

---
module: backend/src/routes
date: 2026-05-17
problem_type: convention
component: authentication
severity: high
applies_when:
  - Adding an auth/re-auth gate (fresh-auth proof, session-token check, etc.) to an existing route
  - The route already runs read-side checks (SELECT for duplicates, existence checks, version queries) before the gate
  - "Composition decision: where to place the new gate relative to those pre-existing checks"
tags:
  - security
  - composition-order
  - enumeration-oracle
  - fresh-auth
  - route-ordering
related_components:
  - rails_controller
---

# Auth/re-auth gate revives pre-existing read-side checks as enumeration oracles

## Context

A route runs a pre-existing read-side check that returns a state-disclosing status code (e.g., `SELECT WHERE email = $1 OR pending_email = $1` returning 409 DUPLICATE on hit). Pre-gate this is benign: every caller reaches the same code paths, and the disclosure is uniform across the population. Then someone adds an auth/re-auth gate (fresh-auth proof, second-factor check, etc.) downstream of the pre-existing check. The gate returns a different status code on failure (e.g., 401 FRESH_AUTH_REQUIRED).

The combination is a new enumeration oracle. A caller with a JWT but no fresh-auth proof probes any candidate value:
- 409 if registered (SELECT succeeds, no further branches needed)
- 401 if not registered (SELECT misses, falls through to gate)

The SELECT did not change. The gate is new. The *composition* enables enumeration that neither check alone enables.

## Guidance

When adding an auth/re-auth gate to a route, **audit pre-existing read-side checks for newly-enabled disclosure paths before merging**. A benign SELECT that always-ran becomes weaponized once a contrasting status code exists downstream.

The architectural fix is route-ordering. The canonical order for an enumeration-prone route is:

1. **Body validation 400s** — reject malformed input. These don't disclose registration state because they reject the same way regardless of whether the value is in the DB. Safe to keep BEFORE the gate.
2. **Auth/re-auth gate consume** — reject unauthenticated/wrong-proof requests with the gate's own status code. Returning consistently for both registered and unregistered cases.
3. **Read-side SELECTs + state mutations + secondary effects** — only run for authenticated callers who passed the gate. Their disclosure is bounded to the gate-passing population.

The discriminator: status codes returned *after* a successful auth check disclose state to authenticated callers (who already have access). Status codes returned *before* the auth check disclose state to anyone holding only the upstream credential (e.g., a JWT). When the upstream credential is weaker than the gate's intended threat model, the pre-gate disclosures become an oracle.

## Why This Matters

The pattern is silent on read. The pre-gate SELECT looks the same at code-review time before and after the gate is added. Static analysis won't flag it. Library tests for the SELECT and the gate independently pass. Only adversarial review (constructing the attack scenario from first principles) surfaces the composition issue.

In PEvO's threat model JWT theft is the accepted upstream prerequisite. Once a JWT is stolen, the attacker has broadcast access via the JWT alone — but they don't have password or fresh-auth proofs. The fresh-auth gate is the defense against full account takeover. If the pre-gate SELECT enables email enumeration via that same stolen JWT, the gate's protection is weakened: an attacker can probe the user's email registration to plan further attacks (phishing, account-recovery social engineering, etc.) without ever needing to bypass the gate.

The fix is mechanical (reorder route steps), the bug is conceptual (a previously-uniform disclosure becomes oracle-shaped under composition). The discipline is checking the composition at every gate-addition.

## When to Apply

- Anytime an auth/re-auth gate is added to an existing route — audit ALL pre-existing checks that run before the gate for disclosure paths.
- Anytime a route's status-code landscape changes (new error envelopes, new discriminator field) — audit pre-existing checks for newly-enabled distinguishability.
- Anytime a security review flags `409 DUPLICATE`, `404 NOT_FOUND`, `409 ALREADY_EXISTS`, or similar registration/existence-disclosing status codes on a route that also runs an auth gate.

Inverse: the pattern does NOT apply when the pre-existing check returns the same status code as the auth gate (e.g., both return 401 on failure). In that case the composition is uniform.

## Examples

**Bug shape** (before fix):

```typescript
// POST /api/settings/email
router.post('/email', verifyHiveSignature, async (req, res) => {
  const { new_email, fresh_auth_proof } = req.body;

  // Body validation — safe before gate
  if (!new_email || typeof new_email !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'new_email required');
  }

  // PRE-EXISTING read-side check — runs before the gate
  const existing = await pool.query(
    'SELECT username FROM accounts WHERE primary_email = $1 OR pending_email = $1',
    [new_email],
  );
  if (existing.rows.length > 0) {
    return sendError(res, 409, 'DUPLICATE', 'Email already registered');  // discloses
  }

  // NEW auth gate — runs after the pre-existing check
  const proofResult = await consumeFreshAuthToken(fresh_auth_proof, req.hiveUsername!, target);
  if (!proofResult.valid) {
    return sendError(res, 401, 'FRESH_AUTH_REQUIRED', 'Fresh auth proof required');  // discloses different state
  }

  // ... actual change-email logic ...
});
```

A JWT-only attacker (no `fresh_auth_proof`) probes any email:
- 409 → registered
- 401 → not registered

**Fix shape** (after reorder):

```typescript
router.post('/email', verifyHiveSignature, async (req, res) => {
  const { new_email, fresh_auth_proof } = req.body;

  // 1. Body validation 400s — safe before gate (uniform across DB state)
  if (!new_email || typeof new_email !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'new_email required');
  }

  // 2. Auth gate consume — uniform 401 for both registered and unregistered
  const proofResult = await consumeFreshAuthToken(fresh_auth_proof, req.hiveUsername!, target);
  if (!proofResult.valid) {
    return sendError(res, 401, 'FRESH_AUTH_REQUIRED', 'Fresh auth proof required');
  }

  // 3. Read-side SELECT — only reached by authenticated callers
  const existing = await pool.query(
    'SELECT username FROM accounts WHERE primary_email = $1 OR pending_email = $1',
    [new_email],
  );
  if (existing.rows.length > 0) {
    return sendError(res, 409, 'DUPLICATE', 'Email already registered');
  }

  // ... actual change-email logic ...
});
```

Now the JWT-only attacker without a fresh-auth proof gets 401 regardless of whether `new_email` is registered. The 409 disclosure is bounded to callers who passed the auth gate.

**Field instances in PEvO (as of 2026-05-17):**

- `backend/src/routes/settings.ts` POST /email — duplicate-email SELECT at lines 147-162 runs BEFORE the fresh-auth gate at line 206-243. Held as task `backend-change-email-mint-path-and-followups` round-2 hold #1 (commit `568c196`). Pre-existing surface from commit b27bcdf; newly enumerable once the gate's 401 was added.

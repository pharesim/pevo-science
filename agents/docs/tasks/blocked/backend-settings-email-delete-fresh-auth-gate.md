# BACKEND-SETTINGS-EMAIL-DELETE-FRESH-AUTH-GATE — DELETE /api/settings/email may be JWT-only-reachable on a destructive action

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by /ce-code-review on backend-recover-email-verification-and-notify round-2, security persona — out of scope for that commit, pre-existing)
**Priority:** P2 (security — destructive-action re-auth)

## Context

During the round-2 review of the recover-email task, the security reviewer flagged that `DELETE /api/settings/email` is mounted with `verifyHiveSignature` but performs no fresh-auth proof check. Per the reviewer's reading, `verifyHiveSignature` accepts a Bearer JWT (not only a Hive signature), so a stolen/replayed JWT alone can reach the handler and delete account data (and, for a light account, destroy the email-based login path).

The sibling sensitive routes — `POST /api/settings/email` (change-email) and the set-password flow — gate on a fresh-auth proof (`computeFreshAuthTargetHash` / `issueFreshAuthToken`). `DELETE /api/settings/email` does not. This is the ARCHITECTURE.md §6.5 invariant-#1 pattern ("JWT-only access on a critical action is a security defect"), and the action is NOT enumerated in §6.4's re-auth-proof contract.

This predates the recover-email work and was not introduced by it.

## [BLOCKED by Architect]

Needs an architect (+ user) decision before backend implements: should `DELETE /api/settings/email` (account email deletion / right-to-erasure) be enumerated as a §6.4 critical action requiring a fresh-auth proof, like change-email and set-password? Or is the current `verifyHiveSignature`-only gate acceptable for this action? The answer determines whether this becomes a gate-adding implementation task or a doc-only clarification of why DELETE-email is exempt.

**First step (can run before the decision):** verify the reviewer's premise — confirm against the actual middleware + route code that `verifyHiveSignature` accepts a Bearer JWT on this route and that no fresh-auth proof is required — before treating this as a live defect. If the premise is wrong (e.g., the route does require a signature/proof), close this task as not-a-defect.

## Goal (pending the architect decision)

- **If "gate it":** add a fresh-auth proof requirement to `DELETE /api/settings/email` mirroring the change-email consume side, widen the mint paths to issue the matching proof target, update ARCHITECTURE.md §6.4 + the settings api-contract doc, and add route tests (401 FRESH_AUTH_REQUIRED without proof; 200 with a valid proof; 403 target_mismatch on a cross-action proof).
- **If "exempt":** document in ARCHITECTURE.md §6.4/§6.5 why DELETE-email is not a fresh-auth-gated critical action, so the next reviewer does not re-flag it.

## Non-goals

- Re-auditing the other settings routes (covered by the change-email cluster, now archived).

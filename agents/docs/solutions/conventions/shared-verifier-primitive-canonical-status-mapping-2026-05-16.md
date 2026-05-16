---
title: Shared verifier primitives must define a canonical status-code mapping; each consumer re-deriving it is drift waiting to happen
date: 2026-05-16
category: conventions
module: backend
problem_type: convention
component: authentication
severity: medium
applies_when:
  - Adding a new consumer of a shared verifier primitive (consumeFreshAuthToken, consumeSessionFreshAuthToken, verifyHiveSignature, or any future primitive returning a discriminated failure-reason union)
  - Reviewing a route that maps verifier-returned reasons to HTTP status codes
  - Auditing the auth surface for status-code consistency across sibling routes consuming the same primitive
  - Implementing a new gate that calls into an existing fresh-auth, signature, or token-verification primitive
  - Refactoring a verifier primitive to add or remove reasons from its return union
tags:
  - status-code-mapping
  - shared-primitive
  - fresh-auth
  - verifier-canon
  - auth-surface-consistency
  - drift-prevention
  - sibling-route-parity
---

# Shared verifier primitives must define a canonical status-code mapping; each consumer re-deriving it is drift waiting to happen

## Context

PEvO has shared verifier primitives that return discriminated-union failure reasons — most prominently `consumeFreshAuthToken` (`backend/src/lib/fresh-auth.ts`) and `consumeSessionFreshAuthToken`. The route layer maps those reasons to HTTP status codes (401 for "you need to (re)authenticate" vs 403 for "you authenticated but the proof is not valid for this resource/account").

Without a canonical mapping at the primitive's boundary, every new route consuming the primitive becomes a fresh chance for the mapping to drift. Reviewers cannot catch the drift by reading the route in isolation — the "right" mapping is convention, not enforced at the type level. Drift compounds silently as the auth surface widens.

## Guidance

**When a shared verifier primitive returns a discriminated failure-reason union, the route consumers MUST follow a single canonical reason→status mapping.** The canonical mapping for `consumeFreshAuthToken` is:

- **403** for `username_mismatch | target_mismatch | kind_mismatch` — caller authenticated but the proof does not belong to them, the resource, or the proof category (caller is identified but lacks the right proof).
- **401** for `missing | expired | malformed` — caller has not produced a valid proof at all (caller needs to (re)authenticate from scratch).

The canonical mapping lives in `custody.ts:371-376` (`POST /api/custody/broadcast`'s fresh-auth gate) as the de-facto reference. The medium-term shape of this convention is to extract the mapping into a helper in `backend/src/lib/fresh-auth.ts` (e.g., `freshAuthFailureStatusCode(reason): 401 | 403`) so every consumer calls one function and a new reason added to the union forces every consumer to update the mapping at compile time. Until that helper lands, the canonical mapping is the rule and reviewers enforce it manually.

Concretely:

1. New consumers of `consumeFreshAuthToken` MUST mirror the custody.ts split exactly, not collapse all reasons to 401 (closed-default-but-wrong-semantics) or re-derive a different split.
2. When `consumeFreshAuthToken`'s reason union widens (or any sibling primitive's), every consumer must extend its mapping in the same commit. If extracting the helper is in flight, prefer landing that first.
3. Architect review of a new auth-surface route MUST check the status-code mapping against the canonical reference, not just at type level (which doesn't catch this).

## Why This Matters

The SPA's generic FRESH_AUTH_REQUIRED handler branches on status code: 401 → "re-authenticate from scratch" UI flow; 403 → "wrong account / wrong proof type" UI flow. When sibling routes disagree on the status code for the same primitive failure, the SPA's user-facing behavior diverges across feature surfaces. A `username_mismatch` on `/custody/broadcast` shows the user the wrong-account warning; the same `username_mismatch` on a set-password endpoint that returns 401 shows the user a confusing re-auth prompt that won't resolve the underlying issue. The user retries, fails again, and stops trusting the auth surface.

Type-level enforcement isn't free here because `sendError`'s `details` parameter is loosely typed (`Record<string, unknown>`) and status codes are integer literals. A typo, a copy-paste from a different verifier's mapping, or a well-intentioned "let me simplify this to always 401" never fails compile. Three things make this convention load-bearing:

1. **Auth-surface routes are added rarely but cluster in time** (any feature requiring re-auth introduces a new consumer). Each addition is a fresh chance to drift.
2. **The "right" mapping is semantic** (401 vs 403 for `username_mismatch` is a domain question, not a syntactic one). Reviewers without the convention re-derive it from scratch each time and may land somewhere different.
3. **The cost of drift compounds**: once two routes disagree, the SPA cannot have a single canonical FRESH_AUTH_REQUIRED handler — it has to branch on `which route did the user just call`, which leaks route identity into auth-error UI logic.

## When to Apply

- Reviewing any new route that calls `consumeFreshAuthToken` or `consumeSessionFreshAuthToken` and maps the result to a status code.
- Reviewing any new shared verifier primitive that returns a discriminated failure-reason union.
- Auditing the auth surface after a primitive's reason union widens (the audit must touch every consumer).
- When the consumer count of any verifier primitive reaches 3+ — at that point, extracting a canonical-mapping helper becomes higher-value than the per-route inline maps.
- Reviewing a sibling-route pair where one is the canonical reference and the other is new code.

## Examples

**Originating incident (2026-05-16):** Three routes consume `consumeFreshAuthToken` after commit `b27bcdf` lands:

- `POST /api/custody/broadcast` (`custody.ts:371-376`) — canonical mapping: 403 for `username_mismatch | target_mismatch | kind_mismatch`; 401 for the rest.
- `POST /api/settings/email` change-email branch (commit `b27bcdf`, `settings.ts:207-210`) — splits 403 for `username_mismatch | target_mismatch`; 401 for the rest. **Misses `kind_mismatch`** — falls through to 401 instead of 403.
- `POST /api/settings/set-password` (commit `9818e32`, `settings.ts:208-230`) — collapses **all** reasons to 401. Diverges on three reasons (`username_mismatch`, `target_mismatch`, `kind_mismatch`).

Each route was implemented in a separate task by a separate worker subagent. Each re-derived the mapping inline. None of them looked at the canonical reference. The `/ce-code-review` fan-out caught the divergence by api-contract + security personas independently flagging the same finding; cross-reviewer agreement promoted it to P1. Without the cross-reviewer corroboration, single-reviewer findings could have been triaged below the gate.

The corrective work: the email-reauth follow-up task (`backend-change-email-mint-path-and-followups.md`) adds `kind_mismatch` to the 403 branch; the set-password hold-block (`backend-settings-set-password-fresh-auth.md` in `tasks/pending/`) brings set-password's mapping fully into line with the canonical 401/403 split. Future drift prevention is this convention.

**Pattern for the helper extraction** (medium-term cleanup, not required by this convention but recommended once consumer count justifies the indirection):

```ts
// in backend/src/lib/fresh-auth.ts
export function freshAuthFailureStatusCode(reason: FreshAuthVerifyResult['reason']): 401 | 403 {
  switch (reason) {
    case 'username_mismatch':
    case 'target_mismatch':
    case 'kind_mismatch':
      return 403;
    case 'missing':
    case 'expired':
    case 'malformed':
      return 401;
  }
  // assertNever(reason) — exhaustive switch; a future reason addition forces every consumer to update.
}
```

After extraction, every consumer becomes a one-liner:

```ts
return sendError(res, freshAuthFailureStatusCode(result.reason), 'FRESH_AUTH_REQUIRED', '...', { reason: result.reason });
```

## Related

- [[timing-equalization-sub-branch-oracles-2026-04-21]] — same shape ("did you think about every sub-branch of the auth primitive when adding a new consumer?").
- [[defensive-gate-co-land-unblocking-surface-2026-05-16]] — sibling convention from the same review cycle covering a different coordination failure on the same primitive.
- [[hive-signature-request-binding-shape-2026-04-21]] — the transport-layer auth this primitive composes with.
- `agents/docs/ARCHITECTURE.md` § 6.4 (re-auth contract — drives which routes call the verifier) and § 6.5 invariant #1.
- `backend/src/lib/fresh-auth.ts` (the verifier primitive — the eventual home of the canonical mapping helper).
- `backend/src/routes/custody.ts:371-376` (canonical reference mapping).
- `agents/docs/tasks-archive.md` BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH entry (archived 2026-05-16) — full review-cycle context.

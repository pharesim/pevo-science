# BACKEND-DECRERR-NARROWING-SYMMETRIC — apply item-8b's `incrErr` narrowing pattern to the pre-existing `decrErr` outer catch

**Owner:** Backend Agent
**Created:** 2026-05-06 (architect, surfaced by kieran-typescript reviewer in round-4 of `backend-verify-broadcast-attempts-cap.md`)
**Priority:** P3 (type-safety symmetry; pre-existing site that became visible alongside item 8b's narrowing in the same file)

## Context

`backend-verify-broadcast-attempts-cap.md` round-4 hold item 8b narrowed the pre-INCR catch in `incrementBroadcastAttempts` (call site at `backend/src/routes/accreditation.ts`):

```ts
} catch (incrErr) {
  logger.warn(
    {
      err: incrErr instanceof Error ? incrErr : new Error(String(incrErr)),
      // ...
    },
    'accreditation.verify pre-INCR cap counter failed — surfacing 503 SERVICE_UNAVAILABLE',
  );
  // ...
}
```

The pre-existing outer catch in the broadcast-timeout decrement path (around `accreditation.ts:512` at the time of round-4) still passes `decrErr` (typed `unknown`) directly to pino:

```ts
logger.warn(
  { err: decrErr, token_hash: hashTokenForLogs(token), username: pending.hive_username, event: 'accred_verify_broadcast_decrement_failed' },
  'accreditation.verify counter decrement after timeout failed — counter may TTL out at token expiration',
);
```

Same file, same pattern, same justification. ioredis `ReplyError` IS an `Error` subclass so production behavior is currently fine; the asymmetry only bites if a non-`Error` rejection ever flows through (mock, edge case, future helper that throws non-Error). Pino serializes `unknown` non-Errors in unpredictable shapes — the parallel narrowing site produces a well-formed `Error` string regardless.

## Goal

Apply the item-8b narrowing pattern symmetrically to all `catch (xxxErr) { logger.{warn,error}({err: xxxErr, ...}) }` sites in `backend/src/routes/accreditation.ts`. Specifically the `decrErr` outer catch (post-504 timeout-decrement path) and any other sibling catches in the same file that pass `unknown` directly to the logger's `err` field.

## Acceptance

1. **Narrowing applied** at every `catch (xxxErr) { logger.{warn,error}({err: xxxErr, ...}) }` site in `backend/src/routes/accreditation.ts`. Pattern: `err: xxxErr instanceof Error ? xxxErr : new Error(String(xxxErr))`.
2. **No mutation-kill regression** in the existing round-4 hold #2 + round-3 hold #5 + round-3 hold #13 specs. The narrowing is internally consistent with item 8b's pre-INCR narrowing.
3. **Optional sibling sweep**: while in the file, scan adjacent route files (`bridge.ts`, `orcid.ts`, `papers.ts`, etc.) for the same `unknown`-to-pino pattern. Filing is OK; this task does not require fixing siblings.

## Why now

Round-4 of `backend-verify-broadcast-attempts-cap.md` archived clean with the narrowing applied to `incrErr` only. The asymmetry in the same file became visible during architect re-review and is a 1-line edit per site. Filing as a small follow-up rather than dragging round-4 into round-5 for an aesthetics-class change on a pre-existing site.

## Out of scope

- Refactoring the broader broadcast-error pipeline (e.g., a unified `narrowToError` helper). The pattern is small enough that inline narrowing is the right level of abstraction; a helper introduces indirection for one line.
- Cross-file sweep of all `unknown`-to-pino patterns project-wide. Sibling files are out of scope unless the implementer chooses to bundle them.

## Source

- `agents/docs/tasks-archive.md` BE-VERIFY-BROADCAST-ATTEMPTS-CAP entry (round-4 architect re-review, finding F4).
- `backend/src/routes/accreditation.ts` item 8b's `incrErr` narrowing (the pattern to mirror).

## Cross-references

- `backend/src/routes/accreditation.ts` `incrementBroadcastAttempts` pre-INCR catch (the canonical narrowing pattern).
- The deferred `backend-bridge-key-startup-validation-and-pino-redact.md` already lands a project-wide `redactErrSerializer` policy that strips known-leaky standard error properties from the `err` payload at pino level. The narrowing in this task is type-safety symmetry, not leak prevention; both layers are independent (narrowing happens at the call site, redaction happens at the serializer). Land independently.

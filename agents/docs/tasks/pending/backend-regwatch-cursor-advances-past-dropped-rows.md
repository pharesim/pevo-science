# collectCompleted advances its cursor past rows an indeterminate Redis read drops

**Owner:** backend
**Created:** 2026-09-09

Routed out of the round-3 architect review of the `accounts.updated_at` writer
canary, which touched this file's docblock. Pre-existing behaviour, unrelated to
that change.

## Why

In `collectCompleted` in `backend/src/jobs/registration-watch.ts`, `maxAt` is
computed from every fetched row before the `seen:accounts` pipeline runs. The
per-row handler then treats an absent result, a per-command error, or a null
`exec()` as "already seen" and announces nothing for that row, which is the
right call on an indeterminate read. But the cursor has already moved past it.

So a Redis read that fails mid-batch drops those registrations from the
announce stream permanently: the rows are never re-selected, because the next
tick queries `updated_at > cursor` and the cursor now sits past them. The
deliberate conservatism of the read handler is undone by the cursor arithmetic
that ran before it.

The same function already documents the inverse care in its closing paragraph:
membership is only read during collection, and marking happens after delivery
succeeds, because marking during collection would drop the batch permanently if
the webhook POST then failed. This is the same hazard one step earlier.

## Scope

1. Compute `maxAt` only from rows whose membership read actually resolved, so a
   partial Redis failure holds the cursor back rather than stepping over the
   rows it could not classify.
2. Keep the empty-batch early return behaving as it does now.
3. Preserve the existing whole-millisecond cursor resolution: the newest row in
   a batch must still stay strictly greater than the cursor derived from it, so
   the re-read on the following tick is unchanged.

## Acceptance criteria

1. A batch in which the membership pipeline returns null, or returns an error
   for one row, leaves the cursor at or below the oldest unclassified row, so
   the next tick re-selects it.
2. A batch that classifies every row advances the cursor exactly as it does
   today.
3. Both are covered by tests. The mocked-pool and Redis fixture shape this
   repo already uses for HAF-route tests applies here; the test file header must
   carry the carve-out justification the project requires when a shared pool or
   Redis helper is mocked.

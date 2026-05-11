# BACKEND-FLUSH-AND-EXIT-DOCBLOCK-COMPLETENESS — Enumerate the fourth `flushAndExit()` call site in the docblock

**Owner:** Backend Agent
**Created:** 2026-05-11 (architect, surfaced by `/ce-code-review` of `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` round-6 commit `311e474` — correctness P3 conf 75)
**Priority:** P3 (docblock completeness; minor regression-resistance gap)

## Why now

Round-6 item #3 of `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` rewrote the `flushAndExit()` docblock at `backend/src/lib/flush-and-exit.ts:15-18` to fix a misdescription ("Used by index.ts boot-fatal sites only" — wrong; the helper is also called from runtime handlers). The rewrite now reads:

> Used by the index.ts boot-fatal site (the boot try/catch in module evaluation) AND by the uncaughtException / unhandledRejection runtime handlers in index.ts.

This enumerates 3 categories of caller:
1. The synchronous boot try/catch (`backend/src/index.ts:83`)
2. `process.on('uncaughtException')` handler (`backend/src/index.ts:38`)
3. `process.on('unhandledRejection')` handler (`backend/src/index.ts:43`)

But `flushAndExit()` has a fourth call site that fits neither category cleanly: `initAppDb().catch(...)` at `backend/src/index.ts:151`, which is the Promise-rejection handler on the boot-time database initialization chain. It's not the synchronous boot try/catch (it fires later, on async DB-init failure), and it's not a runtime error handler in the `process.on(...)` sense (it's a per-call `.catch` on a specific Promise). It IS boot-fatal: the rejection handler logs `'Failed to initialize app database'` and routes through `flushAndExit()` so the fatal line drains under the watchdog.

Reproducer of the misdescription class: round-6 item #3 was filed precisely because the previous "boot-fatal only" claim would have mis-led a future maintainer into adding a bare `process.exit(1)` at a runtime handler that should drain. The same risk applies in reverse: a maintainer adding a NEW boot-time async-failure handler (e.g., `initOrcidPool().catch(...)`) reads the docblock, sees "boot try/catch in module evaluation AND uncaughtException/unhandledRejection," and writes `process.exit(1)` directly because their site fits neither category. Same regression class round-6 closed; one site removed from the enumeration.

P3 because: the heading line ("Boot-fatal flush + watchdog exit") is general-purpose, so a careful reader cross-references; the consequence (a bare `process.exit(1)` skipping the 2s watchdog) is minor and recoverable (the bare `process.exit(1)` still exits, just without the flush-or-watchdog race). But it reproduces the same docblock-completeness class round-6 closed, so closing it is small and worth doing.

## Goal

Update the `flushAndExit()` docblock at `backend/src/lib/flush-and-exit.ts:15-18` to enumerate all four current call sites OR rephrase the "Used by..." sentence to be category-agnostic so it captures the boot-fatal class generically without leaving sites out.

## Acceptance

1. **Docblock edit at `backend/src/lib/flush-and-exit.ts:15-18`.** Two acceptable shapes — the implementer picks one:
   - **(a) Enumerative.** Add the fourth site explicitly: `Used by the index.ts boot-fatal site (the boot try/catch in module evaluation), the initAppDb().catch boot-rejection handler, AND the uncaughtException / unhandledRejection runtime handlers in index.ts.`
   - **(b) Category-agnostic.** Rephrase to a generic invariant that future sites inherit by default: `Used at every boot-fatal and runtime-fatal exit site in index.ts. Any new path that needs to exit the process with a flushed fatal log MUST go through this helper rather than a bare process.exit(1).`
   Shape (b) is the architect's mild preference because it removes the docblock-completeness rot class entirely — future sites no longer need to be added to an enumeration — but shape (a) is also acceptable.
2. **No code change.** Pure docblock edit.
3. **Verification gate.** `npx tsc --noEmit` and `npm run lint` stay clean (no behavior change so this is mechanical).
4. **Targeted-vitest run is not required** for a docblock edit. Full backend vitest run is the parent's fan-out concern; this task lands as a single-file edit.

## Out of scope

- Auditing other docblocks elsewhere in the backend codebase for similar completeness gaps. If you spot one in passing, mention it in the commit message but don't expand the task.
- Re-touching the `flushAndExit()` function body or its callers.
- Converging `routes/auth.ts:175-193` with `flushAndExit` — that's `backend-flush-and-exit-auth-converge.md`'s scope.

## Source

- `/ce-code-review` on commit `311e474` (round-6 of parent task `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT`), architect-driven re-review 2026-05-11.
- Correctness reviewer P3 conf 75: "flushAndExit docblock undercounts call sites — misses initAppDb().catch".
- Cross-reviewer note: maintainability reviewer separately verified the docblock "matches the four real call sites in index.ts (lines 38, 43, 83, 151)" — disagreeing with correctness's read. Disagreement traced to phrasing: maintainability inferred the listed categories cover all four sites; correctness read the categories literally. Architect sides with correctness — the literal read is what a future maintainer would do, so a literal-read miss is a real gap.

## Cross-references

- `backend/src/lib/flush-and-exit.ts:15-18` — the docblock to edit.
- `backend/src/index.ts:38, :43, :83, :151` — the four `flushAndExit()` call sites.
- `agents/docs/tasks/pending/backend-flush-and-exit-auth-converge.md` — sibling follow-up that migrates `routes/auth.ts:175-193` to import `flushAndExit`. After both tasks land, the docblock will need to enumerate five call sites; shape (b) above avoids re-rotting at that point.

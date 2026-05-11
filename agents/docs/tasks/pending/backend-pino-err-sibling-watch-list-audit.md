# BACKEND-PINO-ERR-SIBLING-WATCH-LIST-AUDIT — Codebase-wide scan for err-sibling bypass-redact shapes

**Owner:** Backend Agent
**Created:** 2026-05-11 (architect, filed at archive of `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` per the round-4 hold's "NEW#3" carry-forward)
**Priority:** P2 (defense-in-depth completeness; bounded leak surface)

## Why now

`BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` closed a 6-round arc on the pino `err`-serializer redact policy. The redact wrapper (`backend/src/logger.ts`'s `redactErrInArg` + `redactErrSerializer` + `redactPlainObject` + `safeRedactErr`) catches leaky enumerables on the `err` slot of `{err, ...}`-shaped log args. The convention `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` documents the failure class: a sibling field on the log object (NOT the `err` slot) carrying a leaky error reference bypasses both Layer-A (`redactErrInArg`) and Layer-B (`pino.serializers.err`).

The parent task closed one named site (`backend/src/lib/broadcast-error.ts:270` top-level sibling `cause`) at round-3 hold #1, then closed the sibling-cause spread surface at `:253` at round-4 hold #3 via a function-entry `sanitizedLogContext` destructure. But neither pass audited the rest of the codebase for analogous sibling shapes.

The convention doc's watch list names the sibling-name shapes most likely to introduce a bypass: `originalError`, `wrappedError`, `postErr`, `innerError`, `rootCause`, `nestedError`, `sourceError`, plus `cause`. A codebase-wide grep for these names at log-call sites would surface every site needing either a call-site strip or a project-wide structural guard.

The class is bounded but real: a single overlooked sibling can leak the bridge admin posting key (via `AssertionError.actual/expected`) or an accreditation token (via `ioredis.command.args`) in operator logs, defeating the 6-round redact policy at one mis-shaped site.

## Goal

Audit every `{err, ...}` and equivalent log call site in `backend/src/**/*.ts` for sibling fields whose value is or could be an Error-shaped object. For each hit, either:

- (a) Strip the sibling at the call site (`const { sibling: _ignored, ...rest } = obj; logger.warn(rest, 'msg');` or equivalent), OR
- (b) Pass the value through `redactErrSerializer` (or `redactPlainObject`) at the call site, OR
- (c) Refactor the log call to put the error in the `err` slot only.

Add a project-wide structural guard if the audit surfaces enough sites that case-by-case fixes don't scale. Possible shapes: extend `redactErrInArg` to scan top-level slots for known-leaky shapes; add a lint rule against logging non-`err` slots with Error-shaped values; centralize log-object construction through a helper.

## Acceptance

1. **Grep audit.** Run `grep -rn -E "\b(originalError|wrappedError|postErr|innerError|rootCause|nestedError|sourceError|cause)\b" backend/src/` (or richer pattern). Cross-reference each hit with whether it's a log call site (`logger.{info,warn,error,fatal,debug,trace}`-adjacent or inside a `{...}` literal passed to one) AND whether the field's value could carry a leaky error shape (AssertionError, ioredis ReplyError, VError, dhive-throw).
2. **Hit triage.** For each call site:
   - If the sibling is intentional documentary (e.g., `originalError: 'sentinel-string'`), document the rationale in a code comment and move on.
   - If the sibling could carry a leaky shape, apply (a) call-site strip, (b) per-site `redactErrSerializer` pass, or (c) refactor to `err`-slot.
3. **New tests.** For each fixed site, add a canary test in the nearest test file that fails red if the strip/pass/refactor is reverted (per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`). Mutation-kill verified at commit time.
4. **Project-wide guard (if scope warrants).** If the audit surfaces more than ~5 hit sites, prefer a structural guard over per-site fixes. Architect decides on the guard shape after seeing the audit results — file a brainstorm task back to the architect with the audit's hit count + sample sites if the count is high.
5. **Verification gate.** `npx tsc --noEmit`, `npm run lint`, and full backend vitest pass.
6. **Architect at archive:** new structural guard (if landed) gets a convention-doc entry via `/ce-compound`. Add cross-reference to `pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` documenting the watch list this audit completed.

## Out of scope

- Extending the redact policy to NEW leaky-field shapes (e.g., a new error subclass with leaky enumerables not in the current allowlist). That's a separate audit of `SAFE_BASELINE_FIELDS`.
- Auditing frontend logging — this scope is `backend/src/**/*.ts` only.
- Auditing operational logs from third-party libraries (pinoHttp request log, e.g.) — the redact policy already covers their `err` slot via Layer-B serializers.

## Source

- `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` round-4 architect hold (2026-05-06), "NEW at this hold" item #3:
  > File the codebase-wide watch-list audit follow-up task using `pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md`'s watch list (`originalError`, `wrappedError`, `postErr`, `innerError`, `rootCause`, `nestedError`, `sourceError`) plus `cause`. Scope: scan all `{err, ...}` log-call sites for sibling shapes that bypass redact; either strip them at the call site or add a project-wide structural guard.

Carried forward unchanged through rounds 5 and 6.

## Cross-references

- `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` — the convention this audit completes.
- `backend/src/logger.ts` — `redactErrInArg`, `redactErrSerializer`, `redactPlainObject`, `safeRedactErr`, `SAFE_BASELINE_FIELDS`, `RELAXED_EXTRA_FIELDS`.
- `backend/src/lib/broadcast-error.ts:262-264` — the sanitized-logContext destructure pattern is the reference implementation for option (a).
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — mutation-kill discipline for new canary tests.

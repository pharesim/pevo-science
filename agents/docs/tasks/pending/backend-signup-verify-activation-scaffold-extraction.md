# BACKEND-SIGNUP-VERIFY-ACTIVATION-SCAFFOLD-EXTRACTION — extract withSignupActivationLock + broadcastAccreditationAndSeed shared by /confirm and /link

**Owner:** Backend Agent
**Created:** 2026-05-30 (architect, surfaced by `/ce-code-review` of `backend-signup-activation-failure-recovery-and-pool-hold` round-1)
**Priority:** P2

## Problem

The `/api/auth/confirm` and `/api/auth/link` handlers in `backend/src/routes/signup-verify.ts` duplicate ~110 lines each of the post-lock scaffold: HAF probe + `probeFoundAccreditation` branch + `evidenceHash` derivation + `broadcastJsonWithTimeout` call + `txId` sentinel + `PostBroadcastWriteError` cascade with `classifyPostBroadcastSeverity` + the seed step. Plus the lock acquire/release pattern is copy-pasted at both call sites without a wrapper.

The `backend-signup-activation-failure-recovery-and-pool-hold` task body's "Coordination & opportunistic cleanup" section explicitly named `withSignupActivationLock(...)` extraction as a candidate, with strong rationale: any future change to HAF probe retry logic, severity classification, or `PostBroadcastWriteError` construction must be applied in two places. The redesign that landed in commit `e48b1d60` did NOT do the extraction; instead it **widened** the duplicated section by introducing the new HAF probe + broadcast cascade verbatim across both handlers.

Decoupled from the signup-activation hold cycle so backend can shape the extraction without rush pressure (the design surface around parameterizing `evidenceSuffix`, `recoveryHint`, `routeLabel`, `isResume` cleanly without flag-arg explosion needs deliberation — leaky abstraction is a common refactor failure mode under hold-cycle pressure).

## Goal

Two natural extractions:

1. **`withSignupActivationLock(opts, fn)`** in `backend/src/lib/signup-activation-lock.ts` (or a sibling helper file): wraps the lock acquire/release + try/finally pattern, calls `fn` with the held lock. Decides where the lock-release-before-accreditation seam lives (whether `fn` releases mid-execution and returns a "lock released, accreditation in flight" signal, or whether the wrapper releases on `fn`'s return and the route caller drives the post-release accreditation). Pick whichever shape keeps the route handlers honest with the least ceremony.

2. **`broadcastAccreditationAndSeed(opts)`** in `backend/src/routes/signup-verify.ts` (or a sibling lib file): the post-lock HAF-probe → broadcast → seed cascade. Parameterized over the differences between `/confirm` and `/link` (the username variable, the `evidenceSuffix`, `routeLabel` for log/error messages, `recoveryHint` for the response, and `isResume` for the HAF-probe gate). Avoid flag-arg explosion — prefer one `opts` object with named fields over positional flags.

After extraction, `/confirm` and `/link` each call the shared symbols once. The cited differences (username variable, evidence hash suffix, route-specific message strings, `isResume` discriminator) become explicit named parameters rather than copy-pasted code paths.

## Acceptance

1. **Single shared scaffold.** The HAF-probe + broadcast + `PostBroadcastWriteError` cascade + seed sequence exists in exactly one place; `/confirm` and `/link` both invoke it. The lock acquire/release pattern is wrapped (or the routes use a shared helper that subsumes it).

2. **No behavioral change.** All five existing acceptance criteria from `backend-signup-activation-failure-recovery-and-pool-hold` continue to hold post-extraction (single-fire, crash-resume w/o re-broadcast, encrypt-fail-fast before chain op, no pool starvation, 409 LOCK_HELD on slow holder). The existing test suite (`signup-verify-activation-recovery.test.ts`, `signup-verify-concurrent-activation.test.ts`, `signup-verify.test.ts`) passes without changes — if a test does need adjustment, the change must be cosmetic (e.g., spy targets if call sites move) not behavioral.

3. **Parameterization is clean.** No flag-arg explosion (>4 boolean parameters is a smell). `opts` objects with named fields; discriminated unions where the parameterization is genuinely two-way (e.g., `routeFlavor: 'confirm' | 'link'` if that's the cleanest discriminator).

4. **Comment anchors clean per CLAUDE.md.** New helper docstrings anchor on stable symbols (function name, op-action string, error-class name) — no slug/SHA/line/round-N/§ anchors.

5. **Verification:** `npm run typecheck` (src + tests) clean; `npm run lint` clean; the signup-verify test suite + any newly-added direct tests of the extracted helpers pass.

## Sibling task gating

This task is **NOT a blocker** on the parent `backend-signup-activation-failure-recovery-and-pool-hold` round-2 archive. The hold-fix items in that task (filter narrowing, fail-closed lock, etc.) land first; this extraction can land any time after the hold round resolves. The hold cycle and this refactor naturally land in separate commits to keep blast radius small.

Coordination note: if the signup-activation hold fixes substantively change the post-lock cascade (e.g., the filter narrowing in hold item 1 changes the stuck-recovery branch structure), this extraction should be drafted AFTER those changes land to avoid extracting a soon-to-be-rewritten shape.

## Out of scope

- Any behavioral change to `/confirm` or `/link`. Pure refactor.
- Re-tackling the signup-activation hold-fix items (those land via the parent task).
- Schema changes.
- Performance optimization beyond what the de-duplication naturally provides.

## References

- `backend/src/routes/signup-verify.ts` — current `/confirm` (lines around `571-682`) and `/link` (lines around `881-966`) duplicating the scaffold.
- `backend/src/lib/signup-activation-lock.ts` — the lock module from the redesign; `withSignupActivationLock(...)` could live here or in a new sibling helper file.
- 2026-05-30 architect `/ce-code-review` of `e48b1d60` — maintainability persona M-4 finding (P2, conf 85) plus RR-1 (the copy-pasted lock pattern).
- Parent task `backend-signup-activation-failure-recovery-and-pool-hold` — "Coordination & opportunistic cleanup" section that originally named this extraction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

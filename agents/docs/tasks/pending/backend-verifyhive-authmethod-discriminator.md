# BACKEND-VERIFYHIVE-AUTHMETHOD-DISCRIMINATOR — Expose `req.hiveAuthMethod` on the auth middleware

**Owner:** Backend Agent
**Created:** 2026-05-16 (backend, surfaced by `backend-settings-email-reauth-fresh-auth.md` round-1 implementation)
**Priority:** P3

## Problem

`backend/src/middleware/verifyHiveSignature.ts` is a unified Bearer-JWT + Hive-Signature middleware. The two paths produce identical `req.hiveUsername` and `req.hiveCustody` outputs; route handlers cannot distinguish "was this request authenticated via a JWT (replayable bearer token) or a per-request Hive signature (fresh-proof-bound)?" without re-parsing `req.headers['authorization']` themselves.

Today's call sites that need the discrimination (e.g., `backend/src/routes/settings.ts` POST `/email`, where the JWT path requires a body `fresh_auth_proof` and the Hive-signature path does not) duplicate the same `authHeader?.startsWith('Bearer ')` check inline. Each duplication is a chance to drift — a refactor that moves the JWT-vs-signature decision into the middleware (e.g., to add a third auth path, or to swap one of them out) doesn't get reflected at the route layer.

The settings-email-reauth-fresh-auth task body called this out explicitly:

> Distinguish JWT path from Keychain path by checking whether `req.headers['authorization']?.startsWith('Bearer ')` succeeded (already the discriminator inside `verifyHiveSignature`); a cleaner approach is to expose this via a `req.hiveAuthMethod: 'jwt' | 'signature'` field on the middleware so route handlers don't re-parse headers. If adding that field is non-trivial, use the existing `req.hiveCustody` plus header re-check as a near-term path and file a small follow-up to add the explicit discriminator.

Round 1 of the email task took the header re-check path to avoid colliding with another in-flight worker editing `verifyHiveSignature.ts`. This task is the deferred-explicit-discriminator follow-up.

## Goal

Add a `req.hiveAuthMethod: 'jwt' | 'signature'` field to the Express `Request` namespace augmentation in `verifyHiveSignature.ts`. Populate it from the JWT-path branch (`'jwt'`) and the Hive-signature-path branch (`'signature'`). Migrate the existing `req.headers['authorization']?.startsWith('Bearer ')` re-checks at route call sites to consume the new field.

## Acceptance

1. `req.hiveAuthMethod` is set to `'jwt'` on the JWT-success branch of `verifyHiveSignature` (after `jwt.verify` succeeds and before `next()`).
2. `req.hiveAuthMethod` is set to `'signature'` on the Hive-signature-success branch (after signature recovery + posting-key match).
3. Failures (401 returns) leave the field unset (the request never reaches a downstream handler in this case, but the contract is "set on success only").
4. The Express namespace augmentation in `verifyHiveSignature.ts` declares the field with the union type `'jwt' | 'signature'`.
5. `routes/settings.ts` POST `/email` migrates from `const isJwtPath = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')` to `const isJwtPath = req.hiveAuthMethod === 'jwt'`. Any other call sites discovered in a repo-wide grep for `authorization`-startsWith-Bearer patterns INSIDE route handlers (not in middleware) migrate too.
6. A real-path integration test (in `backend/tests/middleware/`) exercises both branches and asserts the field is set correctly. A separate test asserts the field is consumed correctly at one downstream route (extend `tests/routes/settings-email-fresh-auth.test.ts` or add a similar fixture).

## Out of scope

- Changing the auth model itself (no new auth paths, no removal of JWT support).
- Type-checking that handlers DON'T forget to read the field. A runtime invariant or a lint rule would over-engineer; the migration in acceptance #5 is the audit point.

## References

- `backend/src/middleware/verifyHiveSignature.ts:79` (JWT-path branch where the field would be set to `'jwt'`)
- `backend/src/middleware/verifyHiveSignature.ts:181` (Hive-signature-path branch where the field would be set to `'signature'`)
- `backend/src/routes/settings.ts` POST `/email` (the first consumer; the round-1 commit of `backend-settings-email-reauth-fresh-auth.md` left a TODO referencing this task)
- `backend/src/lib/fresh-auth.ts` (downstream consumer of the JWT-vs-signature decision; the body-proof gate is required only on the JWT path)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-18, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` on the round-1 implementation commit (10 reviewers — correctness + security + adversarial on Opus; testing/reliability/api-contract/maintainability/project-standards/kieran-typescript/learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All six acceptance items land in intent: `req.hiveAuthMethod` set to `'jwt'` on JWT-success and `'signature'` on signature-success; failures leave the field unset; namespace augmentation declares the optional union type; `settings.ts` POST `/email` migrated from inline `authHeader.startsWith('Bearer ')` to `req.hiveAuthMethod === 'jwt'` via the local `isJwtPath` alias; real-path integration test exercises both middleware branches with genuine Hive-signed requests; downstream-consumer extension covers the migration site.

Three items held — one is a substantial cross-reviewer corroborated self-violation (task-slug citations introduced in the same commit that removed a stale line-number anchor — the canonical pattern called out in `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`), one is a stale docblock that contradicts the post-migration state in the same diff, and one is a type-safety drift surface in the test fixture's parameter type.

### Items held (must fix before archive)

**1. (P1, conf 100, 4 reviewers — project-standards × 4 + maintainability + kieran-typescript) Task-slug citations introduced in 4 sites + 3 "Acceptance criterion #N" references in new test source.** This commit removed a stale line-number anchor in `settings.ts` (the comment cited `verifyHiveSignature.ts:79`) and substituted a task-slug citation `BACKEND-VERIFYHIVE-AUTHMETHOD-DISCRIMINATOR` — the exact rot-substitution pattern documented in `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` ("when removing one rot class from a comment, verify the replacement text does not violate any of the rules above; a natural reflex when told 'drop the SHA' is to substitute a task-slug citation; both shapes rot").

  Sites:
  - `backend/src/routes/settings.ts` production comment near the JWT-path discriminator: contains `BACKEND-VERIFYHIVE-AUTHMETHOD-DISCRIMINATOR` parenthetical.
  - `backend/tests/fixtures/mock-auth.ts` fixture docblock: contains the same slug parenthetical.
  - `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts` new file header docblock: opens with `BACKEND-VERIFYHIVE-AUTHMETHOD-DISCRIMINATOR — real-path pin for the req.hiveAuthMethod field...`. Same file inline at the JWT-branch and signature-branch subtests: contains `Acceptance criterion #6 (first half)` and `Acceptance criterion #3` references.
  - `backend/tests/routes/settings-email-fresh-auth.test.ts` new describe-block comment: `BACKEND-VERIFYHIVE-AUTHMETHOD-DISCRIMINATOR — downstream-consumption pin` + `Acceptance criterion #6 (second half)`.

  Suggested fix: rewrite all 4 task-slug sites to behavioral anchors. Production comment in `settings.ts`: "The discriminator below reads `req.hiveAuthMethod` set by the unified `verifyHiveSignature` middleware: the JWT-success branch sets it to `'jwt'`, the signature-success branch sets it to `'signature'`." Fixture docblock in `mock-auth.ts`: "Also mirrors the real middleware's `req.hiveAuthMethod` discriminator: the field is set to `'jwt'` when an Authorization Bearer header is present, `'signature'` otherwise." New middleware test file header: "Real-path pin for the `req.hiveAuthMethod` field set by `verifyHiveSignature`. JWT-success branch sets `'jwt'`; signature-success branch sets `'signature'`; auth failures leave the field unset." Downstream-consumer block in `settings-email-fresh-auth.test.ts`: "Downstream-consumption pin: assert the settings/email route consumes `req.hiveAuthMethod === 'jwt'` correctly via the local `isJwtPath` alias rather than re-parsing the Authorization header." Replace the 3 `Acceptance criterion #N` references with behavioral descriptions of what each subtest pins (e.g., "Real signed-request integration test for the JWT branch", "Downstream-consumer test for settings/email migration").

  Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the replacement prose must not reintroduce task-slug citations, round-N markers, line-number anchors, or SHA references.

**2. (P2, conf 75, correctness + kieran-typescript) Stale docblock in `backend/tests/routes/settings-email-fresh-auth.test.ts` mock-carve-out / clause-(a) justification claims the route still reads `req.headers[authorization]` directly to determine the JWT-vs-signature path; says the discriminator will be extracted to `req.hiveAuthMethod` "once introduced."** This commit IS that introduction — it added `req.hiveAuthMethod` to the middleware AND migrated `settings.ts` POST `/email` to consume the field. The docblock is internally contradictory with the same diff. Same self-violation shape as item 1 from a different angle.

  Suggested fix: rewrite the carve-out justification to describe the post-migration state, naming `MOCK_VERIFY_SIGNATURE` as the mock fixture, naming the production discriminator (`req.hiveAuthMethod === 'jwt'`), and pointing at the new real-path companion at `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts` for clause (c).

**3. (P2, conf 75, kieran-typescript) `MOCK_VERIFY_SIGNATURE` fixture parameter typed `Record<string, unknown>` — union not enforced at write site.** The fixture's `req` parameter is typed `Record<string, unknown>`, so the new `req.hiveAuthMethod = '...'` assignment writes into an `unknown`-valued slot. TypeScript never checks that the assigned literal matches the `'jwt' | 'signature'` union declared in the global `Express.Request` augmentation. A future maintainer adding a third member to the union (or making a typo at the assignment site) gets no compile-time signal. The fixture is the SOLE indirection between test code and production union semantics; the drift hazard is real and accelerated by the new field.

  Suggested fix: change the parameter type from `Record<string, unknown>` to `Pick<Request, 'hiveUsername' | 'hiveCustody' | 'hiveAuthMethod' | 'headers'>`. Imports the augmented `Request` type; re-enables union enforcement at the write site for `hiveAuthMethod` AND for the existing `hiveUsername` / `hiveCustody` assignments. Tests retain their ergonomics; the type widening is local to the fixture.

### Items dismissed during architect triage

- **(low, security residual) Mock-fixture sets `hiveAuthMethod='jwt'` purely on Bearer-header presence; real middleware sets `'jwt'` only after `jwt.verify` succeeds.** Test-only divergence, mitigated by the real-path companion at `verifyHiveSignature-authmethod.test.ts` exercising both branches with genuine signed requests. Per the test-mock carve-out (clauses b + c), the fixture's job is downstream-route behavior not cryptographic verification.
- **(low, correctness CORR-2) Downstream-consumer test cannot distinguish field-driven vs header-driven discrimination — MOCK_VERIFY_SIGNATURE derives `hiveAuthMethod` from the same Authorization Bearer check the old code used.** Real-path companion at the middleware level closes the risk class (mutation reverting the route to inline parse would still fail the middleware tests' direct field assertion). Below the actionable bar.
- **(low, api-contract residual) Stale `dist/middleware/verifyHiveSignature.d.ts` declaration file does not yet declare `hiveAuthMethod`.** Build artifact, not consumed as a type source within the repo. No live defect.

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Items 1-3 touch a mix of `backend/src/routes/settings.ts`, `backend/tests/fixtures/mock-auth.ts`, `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts`, and `backend/tests/routes/settings-email-fresh-auth.test.ts`. Implementer's call whether one bundled commit or two.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-19, commit SHA `8b97461`)

All three round-2 hold items landed in a single bundled commit. Touched files:

- `backend/tests/fixtures/mock-auth.ts` — item 1 (slug + Bearer-presence anchor rewrite in docblock) + item 3 (parameter type narrowed to `Pick<Request, 'hiveUsername' | 'hiveCustody' | 'hiveAuthMethod' | 'headers'>`, `import type { Request } from 'express'` added).
- `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts` — item 1 (file-header docblock rewritten to behavioral anchors; two inline subtest comments stripped of "Acceptance criterion" references and reworded against the middleware contract).
- `backend/tests/routes/settings-email-fresh-auth.test.ts` — item 1 (slug + "Acceptance criterion #6" sites stripped in two places; replacement prose anchors on the `isJwtPath` alias + the no-row-before-JWT invariant) + item 2 (carve-out clause-(a) prose rewritten to describe the post-migration state and to name the real-path companion under clause (c)).

### Item 1 — task-slug + Acceptance-criterion citation strip

Sites the architect listed:

- `backend/src/routes/settings.ts` production comment near the JWT-path discriminator — *already cleaned in a wave-1 commit on a sibling hold*. The current state of that comment (around the `isJwtPath` constant) anchors on `req.hiveAuthMethod` semantics and the middleware's success branches. No further edit needed; verified via `grep -n "BACKEND-VERIFYHIVE-AUTHMETHOD-DISCRIMINATOR"` returning no hits in `settings.ts`.
- `backend/tests/fixtures/mock-auth.ts` fixture docblock — slug parenthetical removed; replacement names the route consumer behaviorally (the change-email branch of POST `/api/settings/email` via the `isJwtPath` alias).
- `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts` file-header docblock — slug + "Acceptance criterion #6 (first half)" replaced with: real-path pin for `req.hiveAuthMethod`; JWT-success sets `'jwt'`, signature-success sets `'signature'`, auth failures leave it unset. Both inline subtest comments ("Acceptance criterion contract" + "Acceptance criterion #3") rewritten to describe the invariant each subtest pins (no leak of an earlier-branch failure into the success label; 401 path never reaches a downstream handler).
- `backend/tests/routes/settings-email-fresh-auth.test.ts` — line-514 inline "Acceptance criterion #6" reworded to "Regression guard for the Keychain Add-flow no-row branch [...] The no-row-before-JWT invariant means this path is unreachable on the JWT discriminator." The describe-block header (formerly slug + "Acceptance criterion #6 (second half)") now reads: "Downstream-consumption pin: assert the settings/email route consumes `req.hiveAuthMethod === 'jwt'` (via the local `isJwtPath` alias) rather than re-parsing `req.headers['authorization']` itself."

Audit-own-replacement: the new prose anchors on stable symbols (`req.hiveAuthMethod`, `isJwtPath`, `MOCK_VERIFY_SIGNATURE`, `verifyHiveSignature`, the no-row-before-JWT invariant) — no new task slugs, SHAs, round-N markers, or line-number anchors introduced.

### Item 2 — stale clause-(a) justification rewrite

The pre-existing prose in `settings-email-fresh-auth.test.ts` claimed the route reads `req.headers['authorization']` directly and that the discriminator would be extracted to `req.hiveAuthMethod` "once introduced." The new prose:

- Names `MOCK_VERIFY_SIGNATURE` as the fixture and notes it mirrors the production `req.hiveAuthMethod` discriminator (set to `'jwt'` when an Authorization Bearer header is present, `'signature'` otherwise).
- Names the production discriminator at the route: `req.hiveAuthMethod === 'jwt'` via the local `isJwtPath` alias.
- Clause-(c) real-path companion explicitly points at `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts`, naming what that file pins (both success branches with real cryptographic verification).

### Item 3 — fixture parameter type narrowing

Parameter signature for the fixture's `verifyHiveSignature` changed from:

```
(req: Record<string, unknown>, _res: unknown, next: () => void)
```

to:

```
(req: Pick<Request, 'hiveUsername' | 'hiveCustody' | 'hiveAuthMethod' | 'headers'>, _res: unknown, next: () => void)
```

with `import type { Request } from 'express'` added at the top. Because the global `Express.Request` augmentation in `backend/src/middleware/verifyHiveSignature.ts` declares `hiveAuthMethod?: 'jwt' | 'signature'`, the `req.hiveAuthMethod = ...` assignment inside the fixture is now checked against that union — and similarly for the existing `req.hiveCustody = ...` assignment against `'light' | 'self'`. A docblock paragraph was added explaining why the narrow type was chosen over `Record<string, unknown>` (so the rationale survives if a future maintainer wonders why the fixture imports an Express type).

### Verification

From `backend/`, after `npm install`:

- `npm run typecheck` (`:src` + `:tests`): clean.
- `npm run lint`: clean.
- `npx vitest run tests/middleware/verifyHiveSignature-authmethod.test.ts tests/routes/settings-email-fresh-auth.test.ts` with `REDIS_URL` + `APP_DATABASE_URL` env overrides per CLAUDE.md "Running Tests": **28/28 pass** in 2.11s. No mock-fixture changes broke the wider consumer set (validated by the `tests/tsconfig.json` typecheck pass, which covers all `MOCK_VERIFY_SIGNATURE` callers).

### Deviations / dismissals during fix

- `settings.ts` production comment-anchor rewrite is out-of-scope for this commit: the slug was already removed and the surrounding comment block already anchors on stable symbols (`req.hiveAuthMethod`, the unified `verifyHiveSignature` middleware, JWT/signature success branches). No new edit was made there.
- Pre-existing line-number anchors in this test file at unrelated sites (e.g., `orcid.test.ts:207-209`, `orcid.test.ts:251-277`) are NOT in scope per the hold block, which named the carve-out clause-(a) docblock and the new describe-block header as the targets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

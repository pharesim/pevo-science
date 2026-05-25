# BACKEND-LOG-PII-HELPER-CONSOLIDATION — Move forensicDigest / hashUserAgentForAudit into lib/log-pii.ts

**Owner:** backend
**Created:** 2026-05-25 (architect, surfaced by /ce-code-review on backend-recover-email-verification-and-notify; maintainability + kieran-typescript persona)
**Priority:** P3 (cleanup; deferred from recover-email closure)

## Problem

`backend/src/routes/auth.ts` defines `forensicDigest(value: string)` returning `crypto.createHash('sha256').update(value).digest('hex')`.

`backend/src/routes/custody.ts` defines `hashUserAgentForAudit(value: string)` with a byte-for-byte identical body. The docblock above `forensicDigest` in `auth.ts` explicitly cites `custody.ts` as the rationale source.

`backend/src/lib/log-pii.ts` already houses related PII-digest helpers: `hashEmailForLogs`, `safeHashEmailForLogs`, `hashTokenForLogs`, `maskEmail`. The forensic-digest helper is generic over `value: string` (not auth-specific or custody-specific) and belongs in the same module.

Two duplicate copies will become three the next time a route needs a full SHA-256 hex digest for audit purposes.

## Goal

Consolidate the duplicate body into a single helper in `lib/log-pii.ts`. Both routes import from there.

## Acceptance

- Add a helper to `backend/src/lib/log-pii.ts` returning `crypto.createHash('sha256').update(value).digest('hex')`. Name it for the data it produces (e.g., `sha256HexDigest` or `forensicDigest` — implementer's call, consistent with the existing naming style in that file).
- `backend/src/routes/auth.ts` imports the helper and removes the local `forensicDigest` definition + docblock.
- `backend/src/routes/custody.ts` imports the helper and removes `hashUserAgentForAudit` (or has it delegate one-line to the new helper if call sites benefit from the domain-specific name).
- Existing tests for both routes still pass — the helper is pure, so call-site equivalence is the regression guard.
- No new behavior introduced.

## Non-goals

- Rename the field at consumption sites (e.g., `request_ip_hash`, `user_agent_hash`). Data-model stable.
- Add new digest variants (HMAC-keyed, scoped, etc.). Pure refactor.

## References

- `backend/src/routes/auth.ts` — `forensicDigest` definition (search by name)
- `backend/src/routes/custody.ts` — `hashUserAgentForAudit` definition (search by name; the docblock cites the duplication explicitly)
- `backend/src/lib/log-pii.ts` — existing PII-hash helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-25, → round-1) — HELD PENDING FIXES

`/ce-code-review` ran with the always-on personas (skipping `ce-agent-native-reviewer` per project CLAUDE.md) plus `kieran-typescript`. The named acceptance criteria all land: `sha256HexDigest(value: string): string` is added to `lib/log-pii.ts`, both routes import it, the `forensicDigest` definition + docblock are gone from `auth.ts`, `hashUserAgentForAudit` survives in `custody.ts` as a thin wrapper that retains the `unknown` → `string` guard. Pure refactor, byte-identical hash output verified against the pinned-vector assertion in `tests/routes/custody-user-agent-hash.test.ts`. No correctness, security, or standards findings.

One missed call site in the same file as one of the consolidations — the canonical "wrapping-primitive exhaustive call-site audit" failure mode.

### Items held (must fix before archive)

**1. (P2, conf 75, maintainability) `backend/src/routes/custody.ts` — `bearerSessionId` still inlines the SHA-256 hex computation that this commit consolidated.**

`bearerSessionId` reads (approximately) `return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);` — the same `createHash('sha256').update(value).digest('hex')` body the commit eliminated from `hashUserAgentForAudit` (defined a few helpers below in the same file) and `forensicDigest`. `sha256HexDigest` is already imported into `custody.ts` by this commit, so the fix is a one-line delegation:

```
return sha256HexDigest(token).slice(0, 16);
```

The `.slice(0, 16)` truncation stays at the call site — it's the compact-correlator contract for the bearer-session ID, distinct from the full-digest contract of `sha256HexDigest`. Only the raw hash computation delegates.

This is the precise failure mode that `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` warned about: after extracting a helper, mental enumeration of call sites is structurally unreliable. The convention prescribes a two-grep audit as the acceptance step. Please run it now as part of this fix:

```bash
grep -rn "createHash('sha256')\|createHash(\"sha256\")" backend/src/
grep -rn "sha256HexDigest" backend/src/
```

The first list minus the second is the set of unconsolidated sites. If `bearerSessionId` is the only remaining site, the consolidation is complete after item 1's one-line fix. If other sites appear, surface them in the next-round commit message so the architect's re-review can confirm the universal-coverage claim. (A site is only "unconsolidated" if its semantics match the helper's contract — full or truncated `sha256` over a string. Non-matching raw `createHash` usages — HMAC, different algorithm, different output encoding — stay inline.)

### Items dismissed / noted

- **No direct unit test pinning `sha256HexDigest`'s output (length 64, lowercase-hex, known vector).** The custody pinned-vector assertion transitively exercises the helper via the wrapper, and `kieran-typescript` + `testing` both confirmed a mutation of the helper body cannot pass custody and fail auth silently. Dismissing per `feedback_dismiss_preemptive_test_hardening`. Adding a direct unit test in `lib/log-pii.test.ts` is acceptable but not required.
- **Naming-register mismatch (`sha256HexDigest` is technique-named in a domain-named module)** — flagged as a residual taste-territory note by `maintainability`. The new docblock positions the helper as a low-level building block, and the module header still describes all callers accurately. Not held.
- **Helpers `auth-structured-log-shape-2026-04-29.md` and `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` were both surfaced by `ce-learnings-researcher`** — the first as supporting context (canonical log-emission shape unchanged), the second as the direct lineage for item 1.

### Re-review signal

When item 1 lands (plus any other sites the two-grep audit surfaces), `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit(s) only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-25, working tree pre-commit)

Item 1 landed. `bearerSessionId` in `custody.ts` now delegates to `sha256HexDigest(token).slice(0, 16)`; the raw `createHash('sha256').update(token).digest('hex')` body is gone, and the `.slice(0, 16)` compact-correlator truncation stays at the call site per the hold note. The `crypto` import is retained (still used by `crypto.timingSafeEqual` elsewhere in the file).

Two-grep audit run per `wrapping-primitive-exhaustive-call-site-audit`. Within this task's consolidation scope (`auth.ts` + `custody.ts`), `bearerSessionId` was the only remaining unconsolidated site; it is now fixed, so the consolidation is complete for the files this task touched.

The audit also surfaced pre-existing inline `sha256`-hex-over-a-string sites in other files that match `sha256HexDigest`'s contract but were never call sites of `forensicDigest` / `hashUserAgentForAudit` / `bearerSessionId` and are out of scope for this focused dedup:

- `routes/search.ts` (cache key, truncated `.slice(0,32)`)
- `routes/papers.ts` (cache key, truncated `.slice(0,32)`)
- `routes/orcid.ts` (×2, `evidence_hash`)
- `routes/signup-verify.ts` (×2, `evidenceHash`)
- `routes/accreditation.ts` (×3: token digest, `evidenceHash`, `idempotencyKey`)
- `routes/anonymousReview.ts` (`attestationId`)
- `lib/idempotency.ts` (idempotency cache key)
- `lib/fresh-auth.ts` (concat digest)

Non-matching sites correctly stay inline (not contract matches): `app.ts` (`.digest('base64')`, CSP hash), `signup-session-binding.ts` (×2) and `recover.ts` (×4) (`.digest()` → Buffer for `timingSafeEqual` / buffer comparison, no hex encoding).

Recommend a separate codebase-wide `sha256HexDigest` adoption sweep (or folding into the existing string-helper adoption sweep) rather than expanding this focused dedup task. Flagging for architect triage per the hold note's "surface them in the next-round commit message."

Verification: `npm run typecheck` clean; `npm run lint` clean on the touched file (one pre-existing unrelated warning in `author-supersession.ts`, untouched); `custody*` + `recover*` + `auth` suites 88/88 pass, including the `custody-user-agent-hash` pinned-vector test that guards byte-identical hash output.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

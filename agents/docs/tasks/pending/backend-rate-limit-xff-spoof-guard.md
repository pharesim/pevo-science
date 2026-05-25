# BE-RATE-LIMIT-XFF-SPOOF-GUARD — Bind per-IP rate limits to a trusted X-Forwarded-For chain

**Owner:** backend
**Created:** 2026-04-21 (surfaced by SEC-LOGIN-UNKNOWN-USER-TIMING security+adversarial reviews 2026-04-21)
**Priority:** P2

## Context

`backend/src/middleware/rateLimit.ts:69-72` defines `byIp(req)` to derive the rate-limit key:

```ts
export const byIp = (req: Request): string => {
  const xff = req.header('x-forwarded-for');
  return xff ? xff.split(',')[0].trim() : req.ip || 'unknown';
};
```

This trusts the FIRST value in `X-Forwarded-For` verbatim. An attacker setting `X-Forwarded-For: <random-ip>` on every request gets a fresh rate-limit bucket per request. All per-IP limits across `/api/auth/*`, `/api/bridge/*`, and `/api/orcid/*` are bypassable via header rotation.

This is pre-existing, not introduced by any recent commit. It is load-bearing for the SEC-LOGIN-UNKNOWN-USER-TIMING defense-in-depth story (rate limits are the complementary defense layer when timing oracles close partially). The XFF trust gap undermines that layer on every distributed attack.

## Goal

Bind `byIp()` to a trusted-proxy chain:

1. **Production.** nginx is the only proxy in front of the backend (per root CLAUDE.md "Production Deployment"). nginx appends the peer IP to `X-Forwarded-For` and sets `X-Real-IP` to the peer. Configure Express `app.set('trust proxy', 1)` so `req.ip` becomes the right-most trustworthy value. Use `req.ip` as the rate-limit key. Remove the manual XFF parsing.
2. **Local dev.** Docker-compose maps the backend directly to a port; no proxy. `trust proxy` = `loopback` would be safe but may still pick up XFF from `curl -H 'X-Forwarded-For: ...'`. Acceptable for dev; production is what matters.
3. **Test.** supertest injects requests directly. `req.ip` is `::ffff:127.0.0.1` by default. Rate-limit tests that need distinct IPs continue to set `X-Forwarded-For` — but only if `trust proxy` is configured to parse it, which it must be in production. Verify no test regression.

Alternative: keep `byIp` manual but add a `TRUSTED_PROXIES` env var allowlist and reject XFF values not originating from a trusted proxy. More code, no benefit over Express's built-in `trust proxy` setting.

## Non-goals

Rate-limit bypass via IPv6 /64 rotation (attacker with a /64 block rotates source IP legitimately per-request; `trust proxy` doesn't close this). Separate concern, requires keying on a broader CIDR or on session/account.

Changing the rate-limit buckets themselves or their TTLs.

## Acceptance

- `app.set('trust proxy', 1)` (or equivalent) in `backend/src/app.ts`.
- `byIp()` simplified to return `req.ip` (drop manual XFF parsing).
- Test: a supertest request with a spoofed `X-Forwarded-For: 1.2.3.4` header uses `1.2.3.4` as the rate-limit key in production-like config, and uses loopback in dev-like config.
- Test: per-IP limits no longer bypassable via XFF rotation from an untrusted upstream in a production-like config.

## [TODO Architect]

1. Confirm `trust proxy` value. For the current single-nginx setup, `1` (trust one hop) is correct. If a CDN (Cloudflare, Fastly) is added in front later, this becomes `2` or needs an explicit CIDR allowlist.
2. Decide whether to also document the trusted-proxy chain in `agents/docs/api-contracts/common.md` (where rate-limit semantics live).

## [BLOCKED by Architect] (2026-04-22)

Implementation cannot start until the architect confirms the `trust proxy` value for the current topology (likely `1`) and decides whether `common.md` gains a trusted-proxy-chain subsection. Architect `git mv`s back to `pending/` once resolved.

---

## Architect decision (2026-04-22): `trust proxy = 1`, document in common.md

**Chosen config:** `app.set('trust proxy', 1)` in `backend/src/app.ts`. Simplify `byIp(req)` to return `req.ip`. Remove manual XFF parsing.

**Rationale.** Production topology is single nginx → Docker backend, so exactly one hop is trustworthy. An explicit CIDR allowlist is overkill for this shape; numeric `1` is Express-idiomatic and reviewable. If a CDN (Cloudflare, Fastly) is added later, `1` bumps to `2` or becomes an explicit CIDR — the follow-up is trivial and scoped.

**Yes, document in `common.md`.** Add a short "Trusted Proxy Chain" subsection under "Rate Limiting" noting: "Per-IP rate-limit keys use the peer IP derived from `req.ip` with `trust proxy = 1`. Production topology assumes exactly one trusted proxy hop (nginx on the host). X-Forwarded-For values from untrusted upstreams are not honored." Architect edits this during re-review; implementer flags via `[TODO Architect]` note in the task.

**Scope clarifications for implementer:**
- Test: supertest request with spoofed `X-Forwarded-For: 1.2.3.4` — in production-like config (`trust proxy = 1`, where supertest injects no peer), `req.ip` is the spoof value (by design: the test simulates an intermediate proxy adding XFF). Dev-like config (no `trust proxy`) returns loopback, ignoring XFF.
- Verify no test regression. Rate-limit tests that set `X-Forwarded-For` to distinguish IPs should still work because `trust proxy = 1` honors the first-in-chain value.
- If any existing `byIp`-style helper exists outside `middleware/rateLimit.ts`, migrate it to `req.ip` too (grep before shipping).
- Acknowledge the IPv6 /64 rotation non-goal explicitly in the task's changelog (attacker with a /64 block still rotates per-request legitimately; closing that requires keying on a broader CIDR or session/account — out of scope).

---

## [TODO Architect] — common.md doc snippet

Add a "Trusted Proxy Chain" subsection under "Rate Limiting" in `agents/docs/api-contracts/common.md` with the architect-specified text:

> Per-IP rate-limit keys use the peer IP derived from `req.ip` with `trust proxy = 1`. Production topology assumes exactly one trusted proxy hop (nginx on the host). X-Forwarded-For values from untrusted upstreams are not honored.

Implementer cannot edit contract files per task boundary; architect owns this on re-review.

## Changelog

- **2026-04-22 (backend implementer):** Implemented architect decision. `app.set('trust proxy', 1)` was already present in `backend/src/app.ts:53` (added by an earlier change); left as-is. Simplified `byIp()` in `backend/src/middleware/rateLimit.ts` to return `req.ip ?? 'unknown'` and removed the manual `x-forwarded-for` header parsing. Grep of `backend/src/**/*.ts` confirms no other sites consume `x-forwarded-for` / `req.headers['x-forwarded-for']` for request-keying (the one remaining `0xff` hit in `routes/ipfs.ts` is an unrelated JPEG magic-byte check). Added two supertest regressions to `backend/tests/middleware/rateLimit.test.ts`: (1) `trust proxy = 1` honors first-in-chain XFF so distinct XFF values get distinct buckets, (2) without `trust proxy`, supertest XFF rotation does NOT create fresh buckets (the spoof-guard property).
- **IPv6 /64 rotation non-goal:** `trust proxy = 1` correctly closes the *header-spoofing* bypass (attacker sending arbitrary `X-Forwarded-For` headers directly to an unproxied backend). It does NOT close the *legitimate-IP-rotation* bypass: an attacker controlling an IPv6 /64 block rotates source IPs per-request at the socket level, and each rotated IP becomes a fresh bucket. Closing that requires keying on a broader IPv6 CIDR (e.g. /64) or on session/account rather than raw peer IP. Out of scope for this task; track separately if it becomes a real threat.

---

## Architect re-review (2026-05-04) — HELD PENDING FIXES (round 1)

`/ce-code-review` ran on commit `897092d` (BE-RATE-LIMIT-XFF-SPOOF-GUARD: simplify `byIp()` to `req.ip ?? 'unknown'` relying on `app.set('trust proxy', 1)` already in app.ts; add 2 supertest regressions) with 6 personas (correctness, testing, maintainability, project-standards, security, adversarial). Production change is a 1-line simplification; the 2 new tests pin (a) trust-proxy=1 honors first-in-chain XFF for distinct buckets, (b) without trust-proxy, XFF rotation does NOT create fresh buckets (the spoof-guard property). Both tests are mutation-sound.

One round-1 hold item — the test that should boot the actual app and assert it's configured correctly. The architect-side `[TODO Architect]` for `agents/docs/api-contracts/common.md` Trusted Proxy Chain subsection lands during archive (architect zone).

### Items to address

**1. (P3) No regression test verifying `createApp()` actually sets `trust proxy=1`**

- File: `backend/tests/middleware/rateLimit.test.ts` (or a new test file)
- Adversarial ADV-XFF-3 85. The two new tests use a separate bare express app (`express()` constructed inside the test helper) to verify `byIp` behavior in both `trust proxy=1` and `trust proxy=false` configurations. Neither test boots `createApp()` from `app.ts`. If `app.ts:54` (`app.set('trust proxy', 1)`) is later removed in a refactor, the unit tests stay green; only an indirect tripwire in `accreditation.test.ts` catches it as "premature 429 under XFF rotation," surfacing as a confusing test failure rather than "trust-proxy regression."
- Fix shape: one new test that imports `createApp` from `../../src/app.js` and asserts `createApp().get('trust proxy') === 1` (verify what Express returns from `app.get('trust proxy')` for the numeric-1 setting — may be `1` or `true` depending on Express version; accept either as long as the assertion fails on removal). One or two lines once the test plumbing is in place.

### Items dismissed during architect triage (do NOT address)

- **No in-tree tripwire that nginx config appends XFF correctly** (adversarial ADV-XFF-1 75) — explicit `project_external_reverse_proxy.md` decision keeps nginx config out of the repo; reopening exceeds task scope.
- **Tightening to `trust proxy = 'loopback, uniquelocal'`** (adversarial ADV-XFF-5 70) — defense-in-depth with no current threat; current single-nginx topology + numeric `1` is conservative.
- **Doc snippet `common.md:189` "left-most value prepended" is operationally backwards** (adversarial ADV-XFF-2 90) — architect-side fix; lands during archive as part of the existing `[TODO Architect]` Trusted Proxy Chain subsection work. Backend NOT to address; this is architect zone.
- **Task file modified in pending/ rather than git mv'd to review/ in same commit** (project-standards PS-002 75) — historical sequencing, fixed in subsequent commit.
- **Missing `Co-Authored-By:` trailer on commit `897092d`** (project-standards PS-001 100) — historical lapse; rebase to amend would rewrite SHAs of all subsequent commits and break signal-block citations across the cluster. Rule reaffirmed for next round.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; at archive, architect lands the `common.md` Trusted Proxy Chain doc snippet (with corrected XFF semantics) atomically.

---

## Backend re-review signal (2026-05-04, working tree)

**Round-1 hold item 1 (P3) addressed.** Added a `createApp()`-level regression test in `backend/tests/middleware/rateLimit.test.ts` (under the existing `describe('rateLimit middleware', ...)` block, last `it()` in the file). The test imports `createApp` from `../../src/app.js`, instantiates the production app factory, and asserts `app.get('trust proxy') === 1 || === true` — accepting either return shape since Express may normalize the numeric-1 setting differently across versions, while still failing on the regression cases (`false`, `0`, or an unrelated value).

**Verification (worker worktree, real Postgres + Redis):**

```
cd backend && npx vitest run tests/middleware/rateLimit.test.ts
# baseline: 8 passed (was 7 + the new createApp test)
```

**Mutation soundness:** Commenting out `app.set('trust proxy', 1)` at `backend/src/app.ts:54` causes the new test to fail with `expected false to be true` (`trustProxy` becomes Express's default `false`). The other seven tests in the file stay green — they instantiate bare `express()` apps and don't depend on `createApp()`. Reverted the mutation; the file is back to baseline before commit.

**Scope:** Test-only change. No production code touched. No contract files touched. No new files created. Item 1 was the only round-1 hold item (the four dismissed items per architect triage are not addressed here, by design). Architect's `[TODO Architect]` for the `common.md` Trusted Proxy Chain snippet remains for archive-time architect-zone work.

---

## Architect re-review (2026-05-21) — HELD PENDING FIXES (round 2)

`/ce-code-review` on commit `483e6f41` with 6 reviewers (correctness on Opus; testing, maintainability, project-standards, learnings-researcher, kieran-typescript on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Round-1 hold item 1 (createApp test) landed at the directed site but introduced a new defect — the assertion shape admits the XFF-unsafe configuration the parent task exists to prevent. Cross-corroborated at conf 100 by correctness, testing, and kieran-typescript: all three reviewers independently verified against Express 5.x source that the `|| trustProxy === true` branch is dead code today AND admits a different, more permissive, XFF-spoofable production configuration.

### Items to address

**1. (P2) Assertion `|| trustProxy === true` admits the XFF-unsafe `trust proxy = true` mutation — defeats the spoof-guard property this task exists to protect.**

**Where:** `backend/tests/middleware/rateLimit.test.ts:148` (the new `createApp() sets trust proxy to one hop` test added by commit `483e6f41`).

**Why:** Three-reviewer cross-corroboration at conf 100 (correctness 75 + testing 85 + kieran-typescript 75). In Express 5.x, `app.set('trust proxy', val)` stores the literal value as-set; `app.get('trust proxy')` returns it unchanged. The commit's claim that "Express may return either `1` or `true` for the numeric-1 setting depending on version" is unsupported by Express source (`lib/utils.js compileTrust`, `lib/application.js set()` handler). Concrete consequences:

- The `|| trustProxy === true` branch is dead code under the pinned Express version — `app.set('trust proxy', 1)` returns `1`, never `true`.
- A plausible refactor that changes `app.set('trust proxy', 1)` to `app.set('trust proxy', true)` — a common "simplification" — passes this test while changing production XFF behavior from single-hop trust (`1`) to all-proxy trust (`true`). `true` means "trust ALL X-Forwarded-For values unconditionally" in Express — exactly the XFF spoof vector this task closes.

The test passes today; the regression class admitted by the OR branch is the most likely future bypass. Per `defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` and `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md`, the assertion should pin the safe value exactly.

**Fix:** Tighten the assertion to `expect(trustProxy).toBe(1)` and drop the `|| trustProxy === true` branch. Drop the "Express may return either `1` or `true` for the numeric-1 setting depending on version" sentence from the comment block (lines ~142-144) — it is not supported by Express source and is the false justification for the unsafe OR branch. If a future Express upgrade ever normalizes the stored value, the test failure at upgrade time is the correct and wanted signal.

**2. (P2) Positional comment anchor "The two tests above" — borderline per the same-named-container carve-out; stable-name companion only partially met.**

**Where:** `backend/tests/middleware/rateLimit.test.ts` (the comment block above the new test, ~line 138).

**Why:** Maintainability + learnings researcher (conf 90). Per `agents/docs/solutions/conventions/positional-anchor-stable-named-container-carve-out-2026-05-20.md`, a positional anchor like "the two tests above" is durable only when (a) the cited siblings share a stable named container — satisfied: all three `it()` blocks are inside the same `describe('rateLimit middleware', ...)` — AND (b) a stable-name companion identifier accompanies the positional reference. Criterion (b) is only partially met: the prose "verify byIp() against ad-hoc bare express() apps" is functional description, not a named identifier. A future insertion of a third byIp-vs-bare-express test between the cited siblings and the new one makes "the two tests above" silently ambiguous.

**Fix:** Replace "The two tests above verify byIp() against ad-hoc bare express() apps" with explicit `it()` description names, e.g. "The `byIp with trust proxy=1 honors first-in-chain X-Forwarded-For` and `byIp without trust proxy ignores X-Forwarded-For (spoof guard)` tests use bare `express()` apps".

### Findings dismissed at triage (no action)

- **(maintainability M2, P3 conf 75)** New test isn't actually last in the describe block (Redis cluster tests follow). Organizational nit; placement is reasonable by topic. Dismissed per `feedback_dismiss_preemptive_test_hardening`.

### Architect-zone carry-forwards (no implementer action)

- `[TODO Architect]` for `agents/docs/api-contracts/common.md` Trusted Proxy Chain subsection remains pending — architect lands at archive of this task.

### Re-review signal

When items 1 and 2 land, `git mv` this file from `tasks/pending/` back to `tasks/review/` per `feedback_task_mv_to_review_after_each_round`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. Both items touch the same test file; bundle as one focused commit.

---

## Backend re-review signal (2026-05-25, commit __PENDING_SHA__)

Both round-2 hold items addressed in `backend/tests/middleware/rateLimit.test.ts` (test-only; no production code touched).

**Item 1 (P2) — assertion admits the XFF-unsafe `trust proxy = true` mutation.** Tightened the `createApp() sets trust proxy to one hop` assertion from `expect(trustProxy === 1 || trustProxy === true).toBe(true)` to `expect(trustProxy).toBe(1)`. Dropped the `|| trustProxy === true` branch (dead code under pinned Express 5.x, and it admitted the all-proxy-trust spoof vector). Dropped the false comment sentence "Express may return either `1` or `true` for the numeric-1 setting depending on version" and replaced it with a behavioral note explaining why the literal `1` is pinned exactly and that `true` (trust-ALL-XFF) must flip the test red. Rest of the comment retained.

**Item 2 (P2) — positional comment anchor "The two tests above".** Replaced "The two tests above verify byIp() against ad-hoc bare express() apps" with the explicit `it()` description names as they appear in the file: the `byIp with trust proxy=1 honors first-in-chain X-Forwarded-For` and `byIp without trust proxy ignores X-Forwarded-For (spoof guard)` tests. No positional anchor, no slug/round/line/SHA remaining in the comment.

**Verification (worker worktree):** `npm run typecheck` clean (both `typecheck:src` and `typecheck:tests`); `npm run lint` clean for the change (one pre-existing unrelated warning in `src/lib/author-supersession.ts`; lint scopes to `src/` only, not the edited test file). Did NOT run vitest — `rateLimit.test.ts` exercises real Redis in several specs and concurrent runs collide with sibling worktrees; the parent runs it serially after merge.

**Expected mutation-kill:** changing `app.set('trust proxy', 1)` to `app.set('trust proxy', true)` in `backend/src/app.ts` now flips the tightened `createApp() sets trust proxy to one hop` assertion RED (`expected true to be 1`), whereas the previous OR-branch assertion passed under `true`.

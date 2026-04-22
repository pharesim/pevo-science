---
title: Timing-equalization security fixes must enumerate every sub-branch of the equalized target
date: 2026-04-21
category: conventions
module: backend
problem_type: convention
component: authentication
severity: high
applies_when:
  - Implementing or reviewing a timing-equalization fix on any auth endpoint
  - Adding `argon2.verify` or `argon2.hash` sentinel burns to mask unknown-user branches
  - A PR touches `/api/auth/login`, `/api/auth/resend-verification`, `/api/auth/recover`, `/api/auth/signup`, or any endpoint with an early-return on unknown identity
  - A security fix claims to "equalize wall-time" between two code paths
  - Reviewing sub-branches (null `password_hash`, ORCID-only accounts, no-password recovery, duplicate-email signup) inside a nominally equalized path
  - An account type (ORCID-only, passwordless, unverified, locked) is added or modified after a timing fix is in place
tags:
  - timing-oracle
  - user-enumeration
  - argon2
  - authentication
  - timing-equalization
  - security-fix-review
  - sub-branch-short-circuit
  - orcid
---

# Timing-equalization security fixes must enumerate every sub-branch of the equalized target

## Context

PEvO commit `6c9a1e0` (SEC-LOGIN-UNKNOWN-USER-TIMING) closed a classic user-enumeration timing oracle on three backend auth endpoints. The oracle: an unknown-account branch that returned in ~1ms was distinguishable from a known-account branch that ran `argon2.verify` (~50-100ms). The fix burned a pre-computed sentinel hash via `argon2.verify(sentinelHash, password).catch(() => {})` on every unknown-account early-return, which is the correct pattern for the primary branch.

The fix passed manual review. It would have shipped.

Architect-invoked `/ce-code-review` adversarial persona caught three sub-branch oracles that the fix itself opened. The class: timing-equalization normalizes two top-level branches against each other, but the equalized "expensive" branch may contain its own conditional sub-branches that short-circuit the expensive work. When the expensive work is skipped inside the "known" branch, the unknown branch (now burning the sentinel) becomes slower than a specific subset of known-account requests. The oracle is not eliminated; it is inverted and narrowed: an attacker can now enumerate the specific sub-class of accounts where the expensive work doesn't run.

All three findings follow the same template: "you equalized branch A (cheap) against branch B (expensive), but branch B contains sub-branch B1 (cheap) — now A is expensive and B1 is cheap, and the attacker gets a cleaner signal than before."

This category is treacherous because:

1. The fix looks complete at the top-level branch boundary.
2. The sub-branch condition may be in a different PR or a later feature (e.g. ORCID-only accounts added after the original timing fix).
3. The false sense of security is worse than no fix — the fix is cited in a code comment as evidence the oracle is closed, which discourages future scrutiny.

The adversarial persona's job is precisely to try to break the fix. Surfacing these flaws requires explicitly enumerating every sub-branch of the equalized path and asking: "can this sub-branch skip the expensive work?" That adversarial enumeration is what caught all three cases; none were surfaced by the non-adversarial review passes.

**Session history (session-historian):** The original SEC-004-BE commit (`2fd4d20`, ~12:10 BST 2026-04-21) made password optional for ORCID-verified accounts but introduced no sentinel. The login timing oracle was flagged in later review (session `86dd6b8d`, ~13:29 BST) as an ORCID-only short-circuit producing ~1ms vs ~100ms, and the fix decision was "Option A — sentinel argon2.verify to equalize timing." The framing at that point was **monolithic**: "burn a verify to close the gap." The ancestor task spec for `SEC-LOGIN-UNKNOWN-USER-TIMING` (filed in session `c11d39d6`, ~19:08 BST) named the three sibling endpoints but did not specify that each sibling's happy-path was itself conditional on account type. **That enumeration gap is the direct ancestor of the three inverted oracles found in review.** (session history)

## Guidance

**Rule: when writing or reviewing a timing-equalization fix, enumerate every sub-branch of the target happy-path. For each sub-branch that can short-circuit the expensive work, either (a) force the expensive work on that sub-branch too, or (b) gate the sentinel burn on the same condition so both branches stay cheap — cheap vs. cheap is also a closed oracle.**

The error pattern has a repeatable shape:

```ts
// WRONG: equalized the top-level "unknown" branch against the
// "known" branch, but the known branch contains a null-hash
// short-circuit that skips argon2.verify entirely.

if (rows.length === 0) {
  const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
  await argon2.verify(sentinelHash, password).catch(() => {});
  return sendOk(res, { message: 'check-obscuring message' });
}

const account = rows[0];
// BUG: null-hash accounts return false in ~1ms; sentinel branch
// now takes ~50ms. Oracle inverted for ORCID-only accounts.
const passwordValid = account.password_hash
  ? await argon2.verify(account.password_hash, password)
  : false;
```

The correct fix is to either run the expensive work unconditionally on the known-account path (removing the short-circuit), or to explicitly equalize the sub-branch:

```ts
// CORRECT option A: remove the null-hash short-circuit from the
// known-account path. ORCID-only accounts still return false, but
// argon2.verify runs in all cases; no sub-branch is cheap.

const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
const passwordValid = await argon2.verify(
  account.password_hash ?? sentinelHash,
  password,
).catch(() => false);
```

For the `/recover` case, where the expensive work (`argon2.hash`) is itself conditional:

```ts
// WRONG: sentinel burn is unconditional, but argon2.hash runs only
// when passwordProvided=true. ORCID recovery without a new password
// (passwordProvided=false) returns from the happy-path in ~5ms;
// unknown-username burns sentinel → ~50ms. Oracle inverted.

if (rows.length === 0) {
  const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
  await argon2.verify(sentinelHash, 'recover-timing-dummy').catch(() => {});
  return sendError(res, 404, 'NOT_FOUND', 'Account not found');
}
// ... later ...
const passwordHash = passwordProvided
  ? await argon2.hash(new_password, ARGON2_OPTIONS)
  : null; // <-- cheap; no argon2.hash

// CORRECT: gate the sentinel burn on whether argon2.hash would run
// on the happy-path for this specific request. If passwordProvided
// is false, neither path runs argon2; the branches are already equal.

if (rows.length === 0) {
  if (passwordProvided) {
    const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
    await argon2.verify(sentinelHash, 'recover-timing-dummy').catch(() => {});
  }
  return sendError(res, 404, 'NOT_FOUND', 'Account not found');
}
```

For `/signup`, where the expensive work is `argon2.hash` and an already-registered email returns a 409 before hashing:

```ts
// WRONG (missed site): 409 DUPLICATE returns before argon2.hash.
// New-email path takes 50-100ms (argon2.hash); already-registered
// 409 takes ~1ms. Two independent signals: status-code + timing.

if (existingRows.length > 0) {
  return sendError(res, 409, 'DUPLICATE', 'Email already registered');
}
const passwordHash = hasPassword
  ? await argon2.hash(password, ARGON2_OPTIONS)
  : null;

// CORRECT: burn sentinel on the early-return 409 path when a
// password was provided (matching what the happy-path would do).

if (existingRows.length > 0) {
  if (hasPassword) {
    const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
    await argon2.verify(sentinelHash, password).catch(() => {});
  }
  return sendError(res, 409, 'DUPLICATE', 'Email already registered');
}
```

**Checklist for every timing-equalization fix, before merging:**

1. Identify the **deliberately-expensive KDF operation** on the "known" branch (`argon2.verify`, `argon2.hash`, `bcrypt.compare`, `scrypt`, etc.). Sentinel equalization works only against operations that take milliseconds. Do NOT include `crypto.timingSafeEqual`, HMAC `.digest()`, or similar fast constant-time comparisons in this step — they are nanosecond-to-microsecond operations and cannot mask the wall-time of a DB lookup, a network call, or email send. See the "Constant-time is not expensive-time" note below.
2. List every sub-branch of the "known" path that can return without reaching the expensive KDF. Include: null-hash ternaries, conditional-argon2 gated on a request field (`passwordProvided`, `hasPassword`), credential-mismatch branches that exit before hashing (wrong-ORCID, wrong-memo-key), and any short-circuit introduced for an account type that bypasses the password flow.
3. For each such sub-branch: either remove the short-circuit (preferred — universal equalization), or gate the sentinel burn on the same condition so both branches take the same cheap time.
4. Enumerate the "unknown" branch's preempting early-returns as well: rate-limit 429s, pool-unavailable 503s, validation-layer 400s, and any catch-handler fast-exit. These are fast on the unknown path but also fast on the known path, so they mostly self-equalize — but confirm rather than assume.
5. **Scope sentinel equalization to argon2 only.** Sentinel-based fixes cannot mask timing differentials from DB query joins, SMTP `sendMail` awaits, Redis round-trips, or HAF query latency. If the happy-path awaits any of those AFTER the argon2 call, the happy-path is systematically slower than the sentinel burn and a new oracle opens in the opposite direction. Either move the I/O off the request path (fire-and-forget, queue, 202 Accepted) or accept the residual leak and document it. See Finding `backend-resend-verification-smtp-timing.md` filed during this review for the canonical SMTP case.

**Constant-time is not expensive-time.** `crypto.timingSafeEqual` and HMAC verification run in microseconds at most; they close the within-comparison branch oracle but add no meaningful wall-time. They are the right tool inside a password/token comparison, but they are NOT a substitute for argon2 when the goal is "mask a DB or I/O timing differential between known and unknown branches." Conflating the two is how a developer ends up with a "constant-time equalized" endpoint that still leaks via DB join time.

## Why This Matters

A security fix that opens a new oracle is strictly worse than no fix for a targeted attacker. Consider `/resend-verification` post-SEC-LOGIN-UNKNOWN-USER-TIMING with the flaw:

- **Before the original fix:** unknown-email → ~1ms, known-email-wrong-password → ~100ms. Oracle yields "does this email have an account?"
- **After the flawed fix:** unknown-email → ~50ms (sentinel), ORCID-only-known-email → ~1ms (null-hash short-circuit). Oracle **inverted**: a targeted attacker probing ORCID-only accounts now gets a faster response than for unknown emails. The attacker's distinguishability signal actually **improved** for that sub-class, because the sentinel added a reliable lower bound on the unknown-email response time.

The code comment inserted by the original fix reads "timing oracle closed." That comment is now a **false attestation**. Future reviewers reading the comment will skip re-examination of the timing properties. The fix creates a false negative in the review process on top of the new oracle.

The adversarial review persona catches this by not trusting the comment. It tries to construct a request that (a) has a known account and (b) takes less time than the sentinel. In `/resend-verification` that is immediately apparent: `account.password_hash ? ... : false` is a 1ms branch for any ORCID-only account. The adversarial question is **"what kind of known account would return faster than the sentinel?"** — that question, asked systematically against every sub-branch, is what every timing-fix review must perform.

This is not theoretical. All three sub-branch oracles were found within one `/ce-code-review` pass. None were found in the non-adversarial pass that preceded it. The difference is the explicit adversarial stance: **assume the fix is wrong and try to break it.**

## When to Apply

1. Any time a commit, PR, or code review contains the phrases "equalize wall-time," "timing oracle," "close timing leak," or "sentinel hash" in comments or commit messages. The fix is in the timing-equalization category and requires full sub-branch enumeration.

2. Any time a fix inserts `argon2.verify`, `argon2.hash`, `crypto.timingSafeEqual`, or any other deliberately slow or constant-time operation onto a branch that previously returned cheaply. The branch receiving the expensive work must be audited for internal short-circuits.

3. Any time an endpoint returns the same status code and message for two different conditions (unknown entity vs. wrong credential; already-registered vs. new signup; etc.) and one condition runs an expensive operation. Both conditions must take the same wall-time on **every** sub-branch, not just on the primary branch.

4. When a reviewer or author states "this branch already runs argon2, so the branches are equalized." That statement is only true if argon2 runs unconditionally on every sub-branch of that path. Verify by tracing all early-returns within the branch.

5. When an account type (ORCID-only, passwordless, unverified, locked) is added or modified after a timing fix is in place. Any new account type that alters the execution path through the expensive operation requires re-auditing all timing-equalization fixes on that endpoint.

## Examples

### Example 1: `/resend-verification` null-hash ternary (`backend/src/routes/auth.ts:299`)

**Before (oracle inverted for ORCID-only accounts):**

```ts
// Unknown-email branch: burns sentinel → ~50ms
if (rows.length === 0) {
  const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
  await argon2.verify(sentinelHash, password).catch(() => {});
  return sendOk(res, { message: 'If that email has a pending signup...' });
}

const account = rows[0];
// ORCID-only account: password_hash is null → short-circuit returns false in ~1ms
// Unknown-email (sentinel): ~50ms
// Signal: ORCID-only accounts are now faster than unknown emails
const passwordValid = account.password_hash
  ? await argon2.verify(account.password_hash, password)
  : false; // ~1ms — oracle inverted
```

**After (use sentinel as fallback hash so `argon2.verify` always runs):**

```ts
if (rows.length === 0) {
  const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
  await argon2.verify(sentinelHash, password).catch(() => {});
  return sendOk(res, { message: 'If that email has a pending signup...' });
}

const account = rows[0];
// Use sentinel as fallback hash so argon2.verify always runs.
// ORCID-only accounts pay the same ~50ms as unknown-email; no sub-branch is cheap.
const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
const passwordValid = await argon2.verify(
  account.password_hash ?? sentinelHash,
  password,
).catch(() => false);
```

### Example 2: `/recover` ORCID recovery without `new_password` (`backend/src/routes/auth.ts:783`)

**Before (happy-path cheap when `passwordProvided=false`, unknown-username sentinel always burns):**

```ts
// Unknown-username: always burns sentinel → ~50ms
if (rows.length === 0) {
  const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
  await argon2.verify(sentinelHash, 'recover-timing-dummy').catch(() => {});
  return sendError(res, 404, 'NOT_FOUND', 'Account not found');
}

// ... credential checks ...

// ORCID recovery without new_password: ~1ms, no argon2.hash
// Unknown-username with orcid_token: sentinel → ~50ms
// Oracle inverted for ORCID-only recovery requests
const passwordHash = passwordProvided
  ? await argon2.hash(new_password as string, ARGON2_OPTIONS)
  : null;
```

**After (gate sentinel burn on `passwordProvided` so both branches are cheap when `argon2.hash` wouldn't run):**

```ts
if (rows.length === 0) {
  if (passwordProvided) {
    const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
    await argon2.verify(sentinelHash, 'recover-timing-dummy').catch(() => {});
  }
  // When passwordProvided=false, both branches (unknown-username 404 and
  // ORCID recovery without password) skip argon2 entirely. No oracle
  // against the "unknown vs known-happy-path" direction.
  return sendError(res, 404, 'NOT_FOUND', 'Account not found');
}

// ... credential checks ...

const passwordHash = passwordProvided
  ? await argon2.hash(new_password as string, ARGON2_OPTIONS)
  : null;
```

**⚠️ Residual oracle on `/recover` after this fix.** Even with the `passwordProvided` gate, a known-user-wrong-credential path (e.g. wrong ORCID bearer at `auth.ts:~731` or wrong memo key at `~:768`) returns 401 without running `argon2.hash`. So when `passwordProvided=true`, the timing-vs-status matrix is:

| Case | Timing | Status |
|------|--------|--------|
| Unknown user | ~50ms (sentinel) | 404 |
| Known user, wrong credential | ~5ms (no argon2.hash) | 401 |
| Known user, correct credential | ~50-100ms (real argon2.hash) | 200 |

Status codes already distinguish these branches (404 vs 401 vs 200), so the timing oracle is NOT the only signal — but an attacker with a valid `orcid_token` who can submit recovery attempts for guessed usernames still learns "is this a real user?" faster via the 401-fast path than via the 404-slow path. **Fully closing this requires equalizing the credential-failure sub-branches too**: burn a sentinel on the 401 paths, or (preferred) restructure so every branch of the known-user path runs `argon2.hash` unconditionally when `passwordProvided=true`. This is the checklist item #2 recursive application — the "known" branch itself contains a sub-branch that short-circuits the expensive work, and the fix propagates downward.

### Example 3: `/signup` already-registered 409 (missed site at `backend/src/routes/auth.ts:144-158`)

**Before (missed: 409 returns before `argon2.hash`; two independent signals leak):**

```ts
// Already-registered email: 409 in ~1ms — no argon2.hash
if (existingRows.length > 0) {
  return sendError(res, 409, 'DUPLICATE', 'Email already registered');
}

// New email: argon2.hash runs → ~50-100ms
const passwordHash = hasPassword
  ? await argon2.hash(password, ARGON2_OPTIONS)
  : null;
// Attacker observes: 409 fast → already registered;
// 400/success slow → new email. Status + timing together.
```

**After (burn sentinel on 409 path when `argon2.hash` would have run for a new email):**

```ts
if (existingRows.length > 0) {
  // Equalize timing with the new-email path that runs argon2.hash.
  // Without this, 409 returns in ~1ms while a successful new-email
  // signup takes 50-100ms — a timing oracle independent of the status code.
  if (hasPassword) {
    const sentinelHash = await SENTINEL_ARGON2_HASH_PROMISE;
    await argon2.verify(sentinelHash, password).catch(() => {});
  }
  return sendError(res, 409, 'DUPLICATE', 'Email already registered');
}

const passwordHash = hasPassword
  ? await argon2.hash(password, ARGON2_OPTIONS)
  : null;
```

**Relevant files:** `backend/src/routes/auth.ts` — sentinel initialization at lines 25-36, `/resend-verification` handler at lines 286-302, `/login` null-hash branch at lines 415-424, `/recover` unknown-username branch at lines 689-700, `/signup` duplicate check at lines 139-153, `argon2.hash` call at lines 156-158.

**Test-environment sensitivity (session history):** `recover.test.ts:440` flaked pre-fix asserting `argon2.verify` burns at least 50ms but returned 42-55ms under CI load. Any new timing assertion added to close the sub-branch oracles must account for this environment variance. The task's hold block uses 40ms as a mutation-kill floor rather than 50ms for this reason. (session history)

### Not covered by sentinel equalization

Sentinel burns mask the argon2 portion of the request path and nothing else. The following oracles remain open and must be addressed by other means (or accepted as residual leaks with explicit documentation):

- **SMTP latency on `/resend-verification` success path.** `transporter.sendMail` is `await`ed synchronously on the happy-path (~200-2000ms depending on provider). Unknown-email burns sentinel (~50ms) and returns. Known-email-with-valid-password-and-pending-verification also burns argon2 (~50ms) PLUS awaits sendMail (200-2000ms) — total 250-2050ms. The sentinel equalizes the argon2 portion, not the SMTP portion. Fix is architectural: fire-and-forget sendMail + 202 Accepted, or move to a job queue. Filed as `backend-resend-verification-smtp-timing.md` in the tasks/pending tree during the review that surfaced this learning.
- **SMTP *failure-mode* status-code oracle.** Distinct from the latency bullet above: when SMTP is unavailable, `sendMail` throws, the known-email path returns 500, and the unknown-email path still returns 200 (burnSentinel succeeds). The attacker observes HTTP status codes, not timing. Filed as `backend-auth-smtp-status-code-oracle.md` and documented at `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` — the failure-mode axis is a sibling convention to this doc, not a subcategory of the wall-time axis.
- **DB join cost differential.** The `/login` query at `auth.ts:~370-389` includes a correlated subquery for `custody_audit_log` that only runs for known users. Under load this is a measurable timing differential that the sentinel does not cover. Pre-existing residual; not closable at the sentinel layer.
- **Validation-layer 400 early-returns.** Requests with malformed bodies return 400 before DB or sentinel. Status code already differentiates, so this is an accepted out-of-scope.
- **Pool-unavailable 503 preempting the sentinel.** `if (!pool) return sendError(res, 503, ...)` on every handler returns in ~1ms on both known and unknown requests when the DB is down. Self-equalizes in most cases; worth confirming per endpoint.
- **argon2 catch-path fast-exit.** `.catch(() => {})` on the sentinel burn silently returns ~0ms if argon2 itself throws (OOM, native-module failure). Under memory pressure this reopens the oracle invisibly. See the hold block's logger.warn item in `tasks/review/backend-login-unknown-user-timing.md`.
- **JIT/V8 warm-up and startup.** First-request-per-cold-function timings can skew equalization assumptions on rarely-hit branches. Accepted residual on busy servers; worth spot-checking immediately after deploy.
- **Sentinel promise startup-window.** `SENTINEL_ARGON2_HASH_PROMISE` is pre-computed at module load. Requests arriving before the promise resolves block on the `await` for the full hash time — acceptable because this only happens during the first ~50ms after process start.

## Related

- `agents/docs/solutions/conventions/object-shape-fix-every-reset-site-2026-04-21.md` — closest structural cousin in the corpus. Both docs teach the same meta-pattern (a fix that covers the reported site but not sibling sites under the same invariant), applied to different domains. That doc addresses partial-fix coverage blindness in Alpine component state resets; this doc addresses the same blindness in authentication timing-equalization. Reading both together surfaces the meta-pattern across security and UI domains.
- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — thematically related ("a fix that doesn't fix what it names"), but mechanically distinct. That doc covers test-infrastructure false-greens where an assertion appears to close a gap but actually permits the mock's fallback path to satisfy it.
- `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md` — adjacent but non-overlapping. Covers a different attack class (replay/forgery) with a different mechanism (canonical string + SETNX replay cache). Mentioned here only because its timing-safe public-key comparison is in the same file-family and confirms the repo's broader "mechanically-enforced security invariants" posture.

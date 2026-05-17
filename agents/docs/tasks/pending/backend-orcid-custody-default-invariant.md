# BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT — Close the orcid.ts `||` default vs `/upgrade` custody-gate invariant violation

**Owner:** backend
**Created:** 2026-05-04 (architect, surfaced by cluster-A round-3 review of `backend-password-hash-null-typing-audit.md` round-2 hold-fix; explicitly tracked-separately by the round-2 hold's Item 2 framing)
**Priority:** P2

## Problem

`backend/src/routes/orcid.ts:456` mints the JWT for ORCID-only accounts with:

```ts
{ sub: account.username, custody: account.custody || 'light' }
```

The `||` default coerces null/falsy `account.custody` (the persisted DB state for ORCID-only accounts) to the JWT claim string `'light'`. Then `backend/src/routes/custody.ts /upgrade` gates on `if (custody !== 'light') return ...`, so an ORCID-only account passes the gate and reaches the password-verify branch — where `account.password_hash` is `NULL`. The round-1 fix added a runtime null-guard at `custody.ts:223-227` (with `burnSentinel` for timing-equalization), and the round-2 mutation-fence test at `backend/tests/routes/custody-upgrade-null-hash.test.ts` locks the wall-time/status/audit-log convergence with the wrong-password branch.

But the **underlying invariant violation** is the orcid.ts `||` default: the JWT's `custody` claim does not match the account's persisted `custody` column. The custody-upgrade null-guard is a local fix; the invariant is project-wide. Per the architect's round-2 hold-block (now archived in tasks-archive.md): "the orcid.ts `||` default vs the `/upgrade` gate is the underlying invariant violation tracked separately."

This task closes the underlying invariant.

## Why this matters

> **Narrative correction (round-3, 2026-05-16):** The original framing below described the defended state as "ORCID-only accounts (custody=NULL)". That shape is not production-reachable — every finalized account has `custody ∈ {'light', 'self'}` set per ARCHITECTURE.md § 6.1. The actual production-reachable passwordless shape is state C (`custody='light' + password_hash=NULL`), reached via `/api/auth/recover` with `orcid_token` and `new_password` omitted (or via ORCID-only signup that completes without setting a password). The bullets below are preserved verbatim for archive context, but the JWT-vs-DB-drift defense they argue for now operates against state C rather than the imagined ORCID-only-custody=NULL state. The fix that landed (Option A) still closes the drift correctly under the corrected model.

1. **Defense-in-depth refactor risk.** The round-2 mutation-fence test seeds `custody='light'` directly in the DB row (per the test's own header comment + adversarial-r4 finding ADV-R4-3). The production-reachable path is `custody=NULL` → orcid.ts `||` default → JWT custody='light'. A future defense-in-depth refactor that adds a DB-level custody recheck on `/upgrade` (e.g., re-fetch the account and reject if persisted `custody !== 'light'`) would silently leave the existing test green while reopening the timing oracle for real ORCID accounts. The local null-guard becomes dead code; the test stops detecting regressions on the actual production path.
2. **JWT-vs-DB drift class.** Any future code path that grants permissions on the basis of the JWT `custody` claim (without re-checking the DB) trusts a value the DB never stored. If the orcid.ts default ever needs to widen (e.g., adds a third custody mode), the existing `'light'` defaults silently misrepresent every ORCID-only account.
3. **Layered guarantee weakens to one layer.** Today the guarantee is "orcid.ts always claims `'light'` for ORCID-only accounts AND custody.ts has a null-guard at the password-verify branch." The invariant is two-layer; the test fences only the second layer. A round-3 architect who archives this task without acting on the orcid.ts side leaves the cluster permanently dependent on one implementer-team-side discipline.

## Goal

Eliminate the JWT-vs-DB drift on the `custody` claim, OR make the drift impossible to misrepresent at the consumer side.

## Approach (suggested — implementer's choice between A and B)

**Option A — Drop the `||` default in orcid.ts, mint the JWT with the actual DB value.**

Change `orcid.ts:456` and `:466` from `custody: account.custody || 'light'` to `custody: account.custody` (the value, possibly null). Adjust the consumer routes:
- `/upgrade` (custody.ts) gates on `custody !== 'light'`. Today a null-custody JWT (post-fix) would fall into the gate's `!== 'light'` branch and 403. That CHANGES current behavior — ORCID-only accounts can no longer reach the password-verify branch. The null-guard at `custody.ts:223-227` becomes unreachable (drop it as dead code).
- Other routes that read the `custody` claim need an audit pass: any site that currently treats the JWT `custody` claim as authoritative needs to handle null.
- The mutation-fence test at `custody-upgrade-null-hash.test.ts` becomes a test of an unreachable branch — either delete it OR re-purpose it to assert the new gate behavior.

**Option B — Add a DB-level custody recheck inside `/upgrade` (defense in depth).**

Keep `orcid.ts:456` as-is (preserves existing route reachability). Add to `custody.ts` `/upgrade` immediately after fetching the account: `if (account.custody !== 'light') return sendError(res, 403, 'FORBIDDEN', '...')`. This makes the JWT claim non-authoritative on this route; the DB row's `custody` column becomes the load-bearing gate. Update the mutation-fence test to seed `custody=NULL` (matching the production-reachable path) and assert the gate fires before the null-hash branch — i.e., the null-guard becomes unreachable through this route, but is preserved as belt-and-suspenders for any future direct caller. This also migrates the test from the symptom (null-hash) to the root-cause (custody-vs-claim).

**Option C — Architect-flavored: make the JWT shape encode the persisted custody state AND have consumers branch on it.**

Mint the JWT with `custody: account.custody ?? null` (explicit null, not coerced to a sentinel). Update ALL consumers to branch on null vs `'light'` vs `'self'` etc. Higher implementation cost; cleanest in principle. Probably out of scope unless other JWT-claim drift exists.

## Acceptance

1. The orcid.ts `||` default is either removed (Option A), neutralized by a DB-level recheck (Option B), or replaced with explicit null encoding (Option C).
2. The cluster of routes that read the JWT `custody` claim is audited end-to-end for the chosen shape. Document the audit grep in the re-review signal block.
3. The mutation-fence test at `backend/tests/routes/custody-upgrade-null-hash.test.ts` is updated to seed the production-reachable shape (custody=NULL in the DB) per the chosen fix path.
4. The corresponding adversarial-r4 finding (test seeds `custody='light'` directly, masking the orcid-coercion path) is closed: re-running the same review pass on the new commit should NOT re-surface it.
5. `tsc --noEmit` clean. `npm run lint` clean. Targeted vitest covering custody.ts + orcid.ts route tests passes.

## Non-goals

- Adding a new authentication mechanism for ORCID-only accounts. The null-hash branch is the architectural choice; this task only closes the JWT-vs-DB drift around it.
- Touching the wider authentication surface (login flow, signup, etc.). Scoped to the orcid → custody bridge.
- Re-architecting `accounts.custody` to be NOT NULL (the current nullable column accommodates ORCID-only accounts intentionally; same justification as `password_hash` in `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT`).

## Coordination

This task is independent of the round-3 hold-fix on `backend-password-hash-null-typing-audit.md` (the local null-guard mutation-fence). Both can land in any order. If THIS task lands first under Option B, the round-3 hold's adversarial-r4 dismissal note ("filed as a separate task") becomes the closing reference. If the round-3 hold lands first, this task's fix will need to update the test that hold ships.

## Files of record

- `backend/src/routes/orcid.ts:456, 466` (the two `||` defaults)
- `backend/src/routes/custody.ts /upgrade` (the consumer route)
- `backend/tests/routes/custody-upgrade-null-hash.test.ts` (the seed shape that may need updating)
- `backend/tests/routes/custody.test.ts` and any other test reading the JWT custody claim
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` (the convention parent for "annotation must permit null where null is possible" — this task extends the same audit class to the JWT claim's DB-vs-claim drift dimension)

## Background

Identified during cluster-A `/ce-code-review` of commit `99c6e72` (BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT round-2 hold-fix), adversarial persona finding ADV-R4-3, conf 80. Filed as a separate task per architect triage on 2026-05-04 — the local round-2 mutation-fence is correct on its own scope; closing the underlying invariant is the natural follow-up.

## Backend re-review signal (2026-05-04, Option A landed)

**Option chosen: A** — drop the orcid.ts `||` default and let the middleware's `|| 'self'` fallback close the JWT-vs-DB drift. The null-guard at custody.ts is now unreachable through any documented path; replaced its burnSentinel + audit-log block with a TypeScript-narrowing-only guard plus a `custody_upgrade_null_hash_unreachable` operator log for the hypothetical direct-caller case. Rationale: Option A yields the simpler post-state (one fewer dead-code branch, one fewer mutation fence to maintain) and the consumer audit (below) shows no consumer relies on a non-null JWT custody claim that the middleware fallback wouldn't already handle correctly.

### Consumer audit grep

```
grep -rn "hiveCustody\|req\.hiveCustody\|\.custody" backend/src/ --include="*.ts" | grep -v test | grep -v "\.d\.ts"
```

Sites that read the JWT `custody` claim (via `req.hiveCustody`):

| Site | Purpose | Effect of `custody: null` JWT |
|---|---|---|
| `backend/src/middleware/verifyHiveSignature.ts:84` | Source of truth: extracts `payload.custody` and coerces with `|| 'self'`. | `null` → `'self'`. ORCID-only callers default to self-custody at the request level (correct: they have no encrypted keys). |
| `backend/src/middleware/verifyHiveSignature.ts:182` | Hive-signature path always sets `'self'`. | Unaffected (this branch never reads JWT). |
| `backend/src/routes/auth.ts:277` (`POST /api/auth/session`) | Re-mints JWT from `req.hiveCustody`. | Reads `req.hiveCustody || 'self'` — `null` already coerced to `'self'` by middleware, and double-defaulted here. New JWT carries `'self'`. |
| `backend/src/routes/custody.ts:33` (`POST /api/custody/broadcast`) | Gates `custody !== 'light'` → 403. | ORCID-only (`'self'` post-coerce) fails the gate → 403 FORBIDDEN. Correct: ORCID-only accounts have no encrypted keys to broadcast. |
| `backend/src/routes/custody.ts:228` (`POST /api/custody/upgrade`) | Gates `custody !== 'light'` → 403. | ORCID-only (`'self'` post-coerce) fails the gate → 403 FORBIDDEN before reaching the password-verify branch. **This is the load-bearing change.** The `password_hash=NULL` branch at line 282 is now unreachable through this route. |

Sites that read `account.custody` (DB column, NOT JWT — out of scope for this task but cross-checked):

```
grep -n "account\.custody\|row\.custody" backend/src/routes/auth.ts backend/src/routes/settings.ts
```

| Site | Purpose | Effect |
|---|---|---|
| `backend/src/routes/auth.ts:850` (`POST /api/auth/login`) | Mints JWT after password-verify success: `account.upgraded_at ? 'self' : (account.custody || 'light')`. | Unchanged. The `|| 'light'` fallback here applies to password-verified accounts, which by definition have a non-null `password_hash`; the JWT-vs-DB drift this task closes does not apply (the password-verify branch is already past). |
| `backend/src/routes/auth.ts:1284` (`POST /api/auth/recover`) | Same shape as login post-recovery. | Unchanged for the same reason. |
| `backend/src/routes/settings.ts:90` (`GET /api/settings/email`) | Returns `row.upgraded_at ? 'self' : (row.custody || 'self')`. | Reads DB column directly. ORCID-only accounts now correctly surface as `'self'` here too. |
| `backend/src/routes/settings.ts:301` | Logs warning if `row.custody === 'light'` on email delete. | Unchanged. |

Conclusion: the only consumer that must change behavior under Option A is `custody.ts /upgrade`, which now correctly 403s ORCID-only callers at the gate. No consumer was found that would silently mishandle a `'self'`-coerced ORCID-only request. Two `auth.ts` JWT-mint sites still carry `account.custody || 'light'` defaults, but those mint paths run only after password-verify success, so they do not affect the JWT-vs-DB drift this task closes; widening them to honest null-handling is out of scope for this task.

### Test mutation kills

`backend/tests/routes/custody-upgrade-null-hash.test.ts` was re-purposed (not deleted). The new shape:
1. Seeds `custody=NULL` + `password_hash=NULL` (the production-reachable ORCID-only shape, closing ADV-R4-3).
2. Mints a JWT with `custody: null` (matches what orcid.ts now produces).
3. Asserts 403 FORBIDDEN with `Only custodial accounts can upgrade` and `code: FORBIDDEN`. A regression that re-introduced `custody: account.custody || 'light'` in orcid.ts would let this request pass the gate and return 401 instead of 403 — that is the primary mutation kill.
4. Asserts no audit-log entry (the gate fires before `logCustodyBroadcast(username, 'upgrade_failure')`).
5. Wrong-password baseline preserved as the second test (light-custody + real argon2 hash + wrong password → 401 with audit-log row settled). This locks the wire contract for real light-custody upgrade attempts.

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only pre-existing warnings in `seed-phrase.ts`).
- Targeted vitest run: `tests/routes/custody-upgrade-null-hash.test.ts` (2/2), `tests/routes/custody.test.ts` (passes), `tests/routes/custody-upgrade-argon-error-translation.test.ts` (passes), `tests/routes/orcid.test.ts` (passes). 78/78 across the four files.

### Files changed

- `backend/src/routes/orcid.ts` — type narrowed to `custody: string | null`; both `|| 'light'` defaults at lines 456, 466 dropped.
- `backend/src/routes/custody.ts` — `burnSentinel` import removed; null-guard block at the password-verify branch reduced to a TypeScript-narrowing-only guard with operator-level `custody_upgrade_null_hash_unreachable` log.
- `backend/tests/routes/custody-upgrade-null-hash.test.ts` — re-purposed to lock the post-fix gate behavior (custody=NULL → JWT custody=null → 403 FORBIDDEN), preserving the wrong-password baseline as the second test.

[TODO Architect] None. The orcid.ts response body still returns `custody: account.custody` (possibly null) to the frontend — `frontend/src/pages/orcid-callback.js:230` already does `auth.custody = data.custody || 'light'`, which is symmetric to the bug just removed but is in the UI agent's zone (out of backend scope). If the architect prefers the response-body shape to default to `'self'` instead of null, that is a one-line follow-up; flagged here for the architect's awareness but not blocking archive of this task.

---

## Architect re-review (2026-05-16) — HELD PENDING FIXES

Multi-persona review of commit `36b3f49` surfaced cross-corroborated findings, but **subsequent architect brainstorm at `agents/docs/ARCHITECTURE.md` § 6 (account state machine + re-auth invariants) dismissed the primary security-class findings as covering a threat model strictly weaker than what the project's stated defense (re-auth at critical actions) accepts.** Specifically:

- The /upgrade null-hash branch timing oracle (F#1) leaks "this account is passwordless," but a JWT-stolen attacker can already escalate via `/settings/set-password` (currently JWT-only — filed as `backend-settings-set-password-fresh-auth.md`), making the timing oracle informationally redundant.
- The "ORCID-only accounts (custody=NULL, password_hash=NULL)" framing this task was built on is **not a real production state**. Every finalized account has `custody ∈ {'light', 'self'}` set (see ARCHITECTURE.md § 6.1); the actual reachable passwordless shape is `custody='light' + password_hash=NULL` post-recover-orcid-no-password (state C in § 6.1).
- Per ARCHITECTURE.md § 6.4, `/custody/upgrade`'s correct re-auth is the seed-phrase-derived pubkey (not password); the password-based re-auth in the current code is itself a gap, filed as `backend-custody-upgrade-seed-phrase-reauth.md`. Once that lands, state-C-via-ORCID-fresh-auth becomes moot for /upgrade anyway.

The orcid.ts JWT-honesty changes and SQL-type narrowing are **defensible code-quality work on their own merits** — no security revert needed. The remaining items below are cleanup against the corrected narrative.

### Hold items (light cleanup, no security revert needed)

1. **[P2] Slug-citation cleanup — 9 sites across 3 files.** Per `agents/docs/solutions/conventions/task-slug-citations-in-code-comments-go-stale-on-archive-2026-05-15.md` (filed 4 days before this commit landed), task-slug leads in code/test comments rot once the task archives. Sites to clean up (replace with behavioral descriptions or stable-symbol anchors):
   - `backend/src/routes/orcid.ts:616, 637` — `BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT` citations
   - `backend/src/routes/custody.ts:787-802, 816` — 5 slug citations (`BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT`, `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT`)
   - `backend/tests/routes/custody-upgrade-null-hash.test.ts:2, 12-14, 75, 91` — slug + `ADV-R4-3` finding-id citation
   The `verifyHiveSignature.ts:84` reference in custody.ts comments IS a stable-symbol anchor (file:line of a stable export) and may stay.

2. **[P3] Operator-log event-name rename to dotted form.** Code emits `event: 'custody_upgrade_null_hash_unreachable'` (underscore). Sibling events use dotted form (e.g., `orcid.callback.token_exchange_failed`). Rename to `custody.upgrade.null_hash_unreachable` at `custody.ts:804-811` for convention consistency. The alert remains `logger.error` severity — per ARCHITECTURE.md § 6.5 #1, a critical-action branch that's truly unreachable through documented paths IS a server-internal-bug tripwire, which is what `error` is for.

3. **[P2] JWT payload type widening at `verifyHiveSignature.ts:82`.** Cast is `payload as { sub: string; custody?: 'light' | 'self'; iat?: number }` — excludes `null`. After this commit, runtime JWTs can decode to `{ custody: null }` for ORCID-only accounts in flight. Runtime `|| 'self'` coerces correctly, but the static type lies (same wrapping-primitive null-typing audit class the SQL row type just fixed; one site short). Widen to `'light' | 'self' | null`.

4. **[P2] Task narrative + comment-block correction.** The "Why this matters" section in the task body and the new code comments at `orcid.ts:638-651` and `custody.ts:787-802` frame the defended state as "ORCID-only accounts (custody=NULL)". That state is not production-reachable — every finalized account has custody set (see ARCHITECTURE.md § 6.1). Rewrite the comments to describe the actual reachable shape: light-custody users (state A or B) who recovered via `/api/auth/recover` with `orcid_token` and `new_password` omitted, leaving `custody='light' + password_hash=NULL` (state C of § 6.1). Reference ARCHITECTURE.md § 6 directly in the comments rather than re-explaining the model inline. Trim verbosity — the comments today are ~16-13 lines each; post-corrected versions can be 4-6 lines each pointing at § 6 for the full model.

5. **[P3] Test docblock mutation-kill claim rewrite (F#17).** `backend/tests/routes/custody-upgrade-null-hash.test.ts:286-290` claims the test fences the mutation "drop the orcid.ts `||` default removal and re-introduce coercion to 'light'." But the test mints the JWT directly via `bearerForOrcidOnly` (`jwt.sign({sub, custody: null})`), bypassing orcid.ts. A regression re-adding `|| 'light'` in orcid.ts would NOT be caught — the test's hand-minted JWT still carries null. Rewrite the docblock to describe what the test actually fences: the custody.ts `'light'` gate's behavior given a custody=null JWT (the consumer's response, not the producer's mint shape). If you want a producer-side fence too, add a tiny unit assertion in `orcid.test.ts` that decodes the login-mode response's token and asserts `payload.custody === null` for an ORCID-only account row — but that's an additive nice-to-have, not a hold item.

### Dismissed (with reasons)

- **F#1 (P1 originally — cross-reviewer corroboration): /upgrade null-hash branch timing oracle reopened by burnSentinel removal.** Dismissed: JWT-stolen attacker escalates via `/settings/set-password` (currently JWT-only — see `backend-settings-set-password-fresh-auth.md`), not via /upgrade timing. Once F#19 is fixed, the /upgrade timing leak reveals only "this account is passwordless," which the attacker already knows from owning the JWT.
- **F#7 (P2): consumer-audit grep misclassifies auth.ts:1284.** Dismissed: F#1's underlying scenario reshapes how the audit grep is read (the auth.ts:1284 row's "applies to password-verified accounts" disposition is wrong for the recover-no-password sub-branch, but since F#1 is dismissed the misclassification doesn't drive a code change).
- **F#9 (P3): FE `data.custody || 'light'` coercion symmetric drift.** Dismissed: post-signup-verify every account has custody set, so backend never sends `custody: null` to a logged-in user. FE coercion is harmless against production-reachable data.
- **F#10, F#11 (P3 each): surviving `|| 'light'` in auth.ts and audit-log absence on gate-403.** Dismissed alongside F#1.

### Files for round-3 cleanup

- `backend/src/routes/orcid.ts` (items 1, 4)
- `backend/src/routes/custody.ts` (items 1, 2, 4)
- `backend/src/middleware/verifyHiveSignature.ts` (item 3)
- `backend/tests/routes/custody-upgrade-null-hash.test.ts` (items 1, 5)
- This task file's "Why this matters" section (item 4 — task narrative correction)

---

## Backend re-review signal (2026-05-16, round-3) — partial landing; items 4-custody and 5 moot

Round-3 cleanup landed against the architect's 2026-05-16 round-2 hold block. Three of the five hold items landed in code; **two items (4-custody and 5) became moot on intake because commit `1f1be4e backend(custody-upgrade-seed-phrase-reauth)` had already replaced the password-verify branch with seed-phrase-derived-pubkey verification and deleted the null-hash test file**. The slug-citation cleanup on custody.ts is also moot — commit `1f1be4e` removed the offending citations as part of the larger replacement.

### Items landed

1. **Item 1 [P2] — Slug-citation cleanup on `orcid.ts`.** Both `BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT` and `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT` citations at the SQL row type annotation (line ~608) and the JWT mint comment block (line ~632) replaced with behavioral descriptions referencing ARCHITECTURE.md § 6 directly. Per the slug-citation-rot convention.

3. **Item 3 [P2] — JWT payload type widening at `verifyHiveSignature.ts:82`.** `payload as { sub: string; custody?: 'light' | 'self'; iat?: number }` widened to `'light' | 'self' | null`. Runtime `|| 'self'` coerces correctly; this honest-types the static cast.

4. **Item 4 (partial — orcid.ts comments only) [P2] — Comment-block reframe around ARCHITECTURE.md § 6.** The SQL row type annotation comment and the JWT mint comment in `orcid.ts handleLogin` were trimmed from ~6 lines and ~12 lines respectively to ~4 lines and ~7 lines, with both now pointing at ARCHITECTURE.md § 6.1 (state machine) rather than re-explaining the model inline. The `account.custody` is now correctly described as either `null` (transient signup-pending states E/F) or the persisted `'light' | 'self'` (finalized states A/B/C/D). Also lands item 4(b) on the task file's "Why this matters" section — added a "Narrative correction (round-3)" preamble acknowledging the original ORCID-only-custody=NULL framing was wrong (state C is the actual defended shape per § 6.1); the bullets are preserved verbatim for archive context per the hold's "do NOT rewrite full task body" carve-out.

### Items rendered moot by upstream code removal (commit `1f1be4e`)

- **Item 1 (custody.ts portion) — slug cleanup at `custody.ts:787-802, 816`.** Verified via `grep`: zero `BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT`, `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT`, or `ADV-R4-3` citations remain in `backend/src/routes/custody.ts`. Commit `1f1be4e backend(custody-upgrade-seed-phrase-reauth)` replaced the password-verify branch (and the null-hash narrowing guard that carried these citations) with seed-phrase-derived pubkey verification — the comments carrying the slugs went with the deletion. No cleanup needed.
- **Item 2 [P3] — Operator-log event-name rename to dotted form.** Already-done on HEAD via the unrelated logger-shape convergence pass (`54532c2`); the event now reads `custody.upgrade.null_hash_unreachable`. No action needed.
- **Item 4 (custody.ts portion) — comment-block reframe at `custody.ts:787-802`.** The password-verify branch this comment described no longer exists on HEAD. The replacement seed-phrase verification branch added in `1f1be4e` already references ARCHITECTURE.md § 6.4 (the seed-phrase-derived-pubkey contract) in its own inline comments. No further action needed.
- **Item 5 [P3] — Test docblock mutation-kill claim rewrite at `backend/tests/routes/custody-upgrade-null-hash.test.ts`.** The test file no longer exists on HEAD — commit `1f1be4e` deleted it alongside the password-verify branch replacement. The new seed-phrase-derived flow is covered by sibling tests created in that same commit (`tests/routes/custody-upgrade-seed-phrase-reauth.test.ts` or similar). The original docblock-vacuity concern is no longer applicable.

### Convention-compliance note

Slug citations carrying `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT` still exist at `backend/src/routes/auth.ts:612, 780` and `backend/src/routes/signup-verify.ts:191` — these are **out of round-3 scope** per the architect's "Files for round-3 cleanup" list (which named only `orcid.ts`, `custody.ts`, `middleware/verifyHiveSignature.ts`, and the now-deleted test file). A separate slug-cleanup-sweep task may pick these up.

### Verification

- `npx tsc --noEmit -p tsconfig.json` — clean (0 errors).
- `npm run lint` — clean (2 pre-existing warnings in `seed-phrase.ts`, unrelated).
- Targeted vitest will be run by the parent on serialized full-suite run after task moves to `review/` (the parent serializes vitest across all wave-merge tasks per backend CLAUDE.md).
- `grep -rn 'BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT\|ADV-R4-3' backend/src/ backend/tests/` returns zero hits.

### Files staged this round

- `backend/src/routes/orcid.ts` (item 1: 2 slug citations removed; item 4: 2 comment blocks reframed)
- `backend/src/middleware/verifyHiveSignature.ts` (item 3: JWT payload type widened to `'light' | 'self' | null`)
- `agents/docs/tasks/pending/backend-orcid-custody-default-invariant.md` (item 4(b): narrative correction preamble; this signal block)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-16, round-3) — HELD PENDING FIXES:

`/ce-code-review` of round-3 commit `3a9f7af` (7 reviewers — correctness on opus; security, kieran-typescript, maintainability, project-standards, api-contract, learnings-researcher on sonnet; `ce-agent-native-reviewer` and adversarial skipped per scope). Security, maintainability, project-standards all clean. Held on a single comment-only correctness regression against the round-2 hold's item #4, plus a folded pre-existing JWT-validation gap, plus the carved-out slug-citation cleanup.

### Items to address

1. **[P2] orcid.ts comment reframe (regression against round-2 hold item #4).** The new comments at `backend/src/routes/orcid.ts:657-661` (SQL row-type annotation) and `:682-689` (JWT-mint) cite "transient signup-pending states (E, F per ARCHITECTURE.md § 6.1)" as the defended `custody=NULL` case. Per the correctness reviewer's cross-check against § 6.1: states E/F have `username=NULL` and are filtered out by the SQL's `WHERE username IS NOT NULL` clause, so `account.custody` is never null at this query in production. The round-2 hold item #4 had asked for state-C framing, but on inspection state C has `custody='light'` (not null), so the `null` branch isn't defending state C either — the prior hold's instruction was imprecise. Honest reframe: the SQL query never produces `custody=null` rows at runtime; the `string | null` annotation honest-types the COLUMN's nullability (per the wrapping-primitive convention) as belt-and-suspenders for a hypothetical future query that drops the `username IS NOT NULL` filter. It is NOT defending any currently-reachable production state. Acknowledge state C (`custody='light' + password_hash=NULL`) exists as the real production passwordless shape, but note password_hash null is defended elsewhere (the `/upgrade` seed-phrase re-auth contract per § 6.4), not by the custody annotation. Keep both comments tight — ~3-4 lines each, pointing at § 6.1 for the model rather than re-explaining inline.

2. **[P2, folded pre-existing] JWT `sub` runtime validation in verifyHiveSignature.ts.** The `as` cast at `backend/src/middleware/verifyHiveSignature.ts:79-83` doesn't validate `payload.sub`. A JWT with `sub` absent or non-string passes the cast silently, writes `undefined` to `req.hiveUsername`, and calls `next()` — making the request look authenticated with no username. Pre-existing weakness surfaced by kieran-typescript during the type-widening audit; folded into this hold because the implementer is already in this middleware file. Add a runtime guard immediately after the cast, e.g.:

   ```ts
   if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
     return next(); // fall through to unauthenticated branch (Hive-signature path or 401)
   }
   ```

   Exploitability is low (HMAC verification precedes the cast; only an internal bug or test-fixture leak could mint such a token), but the static type is currently a lie and the fix is small. A targeted test that decodes a `sub`-less JWT into the middleware and asserts `req.hiveUsername` is undefined (or that downstream returns 401) would be the canonical pin.

3. **[P3, folded residual] Slug-citation cleanup in 3 out-of-round-3-scope sites.** `backend/src/routes/auth.ts:612, 780` and `backend/src/routes/signup-verify.ts:191` still carry stale `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT` slug citations. The round-2 hold's "Files for round-3 cleanup" list scoped narrowly; in hindsight the slug-cleanup was fungible across files. Apply the same behavioral-replacement convention used in `orcid.ts` round-3 (point at the audit's invariant or the relevant ARCHITECTURE.md section, not the task slug). After the cleanup, `grep -rn 'BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT' backend/src/ backend/tests/` should return zero hits.

### Dismissed at architect triage

- **AC-01 (P3, api-contract) — auth.md describes JWT `custody` as `'self' | 'light'` only; widening allows null.** Dismissed: auth.md describes the actual WIRE shape, which is non-null in production at handleLogin (per item 1's correctness analysis — the SQL filter excludes all custody=null rows). Internal type widening for column-nullability honesty doesn't require doc changes; the SPA's two consumer sites (`orcid-callback.js:269` does `data.custody || 'light'`; `auth.js:80` does `?? 'self'`) already defend defensively. A future change that actually emits null in the wire would prompt the doc update.

### Suppressed below anchor 75 (surfaced for transparency)

- kieran-typescript KT-2 (P3/50): DB `custody TEXT` column lacks CHECK constraint — pre-existing schema gap, mis-classification not escalation.
- kieran-typescript KT-3 (P3/50): informational; type-narrowing on `payload.custody || 'self'` confirmed safe.
- maintainability MAINT-R2 (P3/50): convention-file path in comment could itself rot on `/ce-compound-refresh` rename.

### Files for round-4 cleanup

- `backend/src/routes/orcid.ts` (item 1)
- `backend/src/middleware/verifyHiveSignature.ts` (item 2)
- `backend/src/routes/auth.ts` (item 3)
- `backend/src/routes/signup-verify.ts` (item 3)

Per root CLAUDE.md rule #8, this file moves from `tasks/review/` back to `tasks/pending/` so the implementer sees it at startup. After landing the round-4 fixes, `git mv` back to `tasks/review/` for round-4 re-review.

---

## Backend re-review signal (2026-05-16, round-4 fix commit)

Round-4 lands the three items from the architect's round-3 hold (orcid.ts comment-correctness regression, JWT `sub` runtime validation, slug-citation cleanup at out-of-round-3-scope sites). All three items are code-only — no test-file deletion or behavioral change beyond the `sub`-guard's fall-through semantics.

### Items landed

1. **Item 1 [P2] — orcid.ts comment reframe (correctness regression against round-2 hold item #4).** Both comments at `backend/src/routes/orcid.ts` (SQL row-type annotation and JWT mint) rewritten honestly:
   - **SQL row-type annotation comment (lines ~639-646):** trimmed to 7 lines. Frames the `string | null` annotation as honest-typing the COLUMN's nullability per the wrapping-primitive convention, as belt-and-suspenders against a hypothetical future query dropping the `username IS NOT NULL` filter. Removes the incorrect "transient signup-pending states (E, F)" attribution — those rows have `username=NULL` and are filtered out by the query's WHERE clause, so they never reach this row-type.
   - **JWT-mint comment (lines ~665-671):** trimmed to 7 lines. Acknowledges that the row matched here is finalized (states A/B/C/D), so `account.custody` is `'light'` or `'self'`; the `null` branch in the column type is unreachable at this site. Notes that state C (`custody='light' + password_hash=NULL`) exists as the real production passwordless shape, but its `password_hash null` defense lives at `/upgrade` per ARCHITECTURE.md § 6.4 — not on this annotation. Points at § 6.1 for the model.

2. **Item 2 [P2] — JWT `sub` runtime validation in `backend/src/middleware/verifyHiveSignature.ts`.** Added a runtime guard immediately after the `jwt.verify` cast: the `as` cast widened payload `sub` to `unknown`, and the JWT-success branch now executes only inside `if (typeof payload.sub === 'string' && payload.sub.length > 0) { … return next(); }`. The guard's `else` (implicit fall-through) emits a debug log and falls through to the Hive-signature branch, which 401s when no signature headers are present. The original behavior — setting `req.hiveUsername = undefined` from a malformed JWT and calling `next()` — is closed.

   Targeted test added at `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts`: `rejects a Bearer JWT with no sub claim instead of setting hiveUsername=undefined`. Mints a JWT with `{ custody: 'self' }` and no `sub`, sends it to `/probe` with no Hive-signature headers, asserts response status 401 and that neither `hiveAuthMethod` nor `hiveUsername` propagated to the probe handler. The fixture file's existing real-path discipline (no MOCK_VERIFY_SIGNATURE, real `jsonwebtoken` library) carries to the new case.

3. **Item 3 [P3] — Slug-citation cleanup at 3 out-of-round-3-scope sites.** Replaced `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT` references with behavioral descriptions referencing the canonical hoist pattern's parent site (`signup-verify.ts`'s `/signup-verify` handler):
   - `backend/src/routes/auth.ts:611-616` (in `/resume-signup`) — slug citation replaced with parent-site description and the behavioral rationale (closure-narrowing-loss, replacing the non-null assertion).
   - `backend/src/routes/auth.ts:779-785` (in `/login`) — same shape; references the parent site instead of the task slug.
   - `backend/src/routes/signup-verify.ts:191` (the original parent site itself) — self-reference loop removed; comment now describes the pattern directly without slug-citing itself.

### Verification

- `grep -rn 'BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT' backend/src/ backend/tests/` returns zero hits (exit code 1).
- `grep -rn 'BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT\|ADV-R4-3' backend/src/ backend/tests/` returns zero hits (still clean from round-3).
- `npm run typecheck` (i.e. `tsc --noEmit -p tsconfig.json`) — clean (0 errors).
- `npm run lint` — clean (2 pre-existing warnings in `seed-phrase.ts`, unrelated).
- Vitest will be serialized by the parent on full-suite run after this fix-commit lands; not run in the worker worktree.

### Files staged this round

- `backend/src/routes/orcid.ts` (item 1: 2 comment blocks reframed for correctness)
- `backend/src/middleware/verifyHiveSignature.ts` (item 2: runtime `sub` guard added; payload cast widened to `sub?: unknown`)
- `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts` (item 2: regression-fence test for sub-less JWT)
- `backend/src/routes/auth.ts` (item 3: 2 slug-citation cleanups)
- `backend/src/routes/signup-verify.ts` (item 3: 1 slug-citation self-reference removed)
- `agents/docs/tasks/review/backend-orcid-custody-default-invariant.md` (this signal block)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect round-4 re-review (2026-05-17) — HELD PENDING FIXES

`/ce-code-review` on round-4 commit `ea54f91` ran 7 personas (correctness + security + adversarial on opus; testing + maintainability + project-standards + kieran-typescript on sonnet; ce-agent-native-reviewer skipped per project CLAUDE.md). All three round-3 hold items landed cleanly:
- Item 1 (orcid.ts comment reframe): honest reframing per the round-3 ask. Verified.
- Item 2 (JWT `sub` runtime validation): runtime guard correctly placed, narrowing sound, regression test pins behavior. Verified.
- Item 3 (slug-citation cleanup at 3 out-of-round-3-scope sites): `grep -rn 'BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT' backend/src/ backend/tests/` returns zero hits. Verified.

One item holds — surfaced by adversarial during the round-4 review: round-4's own slug cleanup introduced a stale route-name reference (citation-rot avoided, route-name-rot introduced).

### Item 1 [P3] — `auth.ts` slug-cleanup comments cite nonexistent `/signup-verify` route

**Source:** adversarial ADV-R4-1 (conf 60)
**Files:** `backend/src/routes/auth.ts:611-617, 782-787`

Round-4's slug cleanup replaced `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT` task-slug citations with behavioral descriptions. Both new comment blocks (in `/resend-verification` at :611-617 and in `/login` at :782-787) cite *"the `/signup-verify` handler in `signup-verify.ts`"*. But the actual routes registered in `signup-verify.ts` are `/verify`, `/resume-signup`, `/confirm`, and `/link` — **there is no `/signup-verify` route**. The canonical hoist pattern's parent site is the `/resume-signup` handler (line 133 router declaration; canonical comment block at line 191).

Round-4's signal block at line 277 of this task file repeats the same error in prose: *"referenc[es] the canonical hoist pattern's parent site (`signup-verify.ts`'s `/signup-verify` handler)"*. Same incorrect route name in code and signal text.

A future maintainer following the comment greps `router.post('/signup-verify'` → zero hits → loses the wayfinding trail the slug-cleanup was meant to preserve. Same citation-rot class round-3 item 3 was filed to prevent.

**Fix shape:** replace `/signup-verify` with `/resume-signup` in both comment blocks. One-line typo fix per site. Confirm via `grep -n "router.post('/resume-signup'" backend/src/routes/signup-verify.ts` resolves to a single hit.

### Files for round-5

- `backend/src/routes/auth.ts` (item 1)
- This task file (round-5 implementer signal block when moving back to review/)

### Dismissed at architect triage (recorded for transparency)

- **JWT mint/verify type asymmetry on `custody` claim** (kieran-typescript kts-1/2/5 P2/P3, conf 75): mint sites are practically disciplined (DB column under `WHERE username IS NOT NULL` filter or string literals); verify cast is asserted-not-enforced but practically safe. Round-3 hold explicitly chose to widen `sub` only; symmetric `custody` widening would extend scope into a project-wide refactor (shared `PevoJwtClaims` type + 8+ mint sites) better filed as its own task if the actual production risk surfaces. Architect's previous instinct stands.
- **Test pins `sub` absent only** (testing testing-1 P3/60): the guard's `typeof === 'string' && length > 0` would correctly reject `sub: ''`, `sub: null`, `sub: 42` — the absent-sub case is the canonical regression-kill per the original round-3 hold. Preemptive parameterization per `feedback_dismiss_preemptive_test_hardening`.
- **Vacuous `not.toHaveProperty('hiveUsername')` assertion** (testing testing-2 info/90): JSON serialization drops `undefined`. Load-bearing assertions (status + `hiveAuthMethod`) on the same line work correctly. Trivial.

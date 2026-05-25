# BACKEND-PEVO-ADMIN-KEY-STARTUP-VALIDATION — Validate `pevoAdminPostingKey` at server startup so a malformed key fails boot, not a runtime 504

**Owner:** backend
**Created:** 2026-04-28 (architect, surfaced by `/ce-code-review` of `BACKEND-ORCID-ACQUIRED-BRANCH-THROW-GUARD` commit `0d0c156`)
**Priority:** P3
**Source:** Cluster A `/ce-code-review` of `0d0c156` — agent-native AN-001 + reliability REL-001 + adversarial adv-001 (3-reviewer convergence, conf 100 after promotion).

## Problem

`BACKEND-ORCID-ACQUIRED-BRANCH-THROW-GUARD` (commit `0d0c156`) added a wrapper-level catch on `withOrcidBindingLock`'s `'acquired'` branch that routes every escaping throw through `handleBroadcastErrorAmbiguous` → 504 `BROADCAST_TIMEOUT` with `outcome:'uncertain'`, `verify_before_retry:true`, `verify_location:'/settings'`.

Two throw classes route through that catch at HEAD:

1. **Post-broadcast cascade throws** — `cacheOrcidBinding` / `__test_seams.updateAccountOrcid` / `seedAccreditationBonus` rejecting after the broadcast succeeds. Wrapped by `fn` as `PostBroadcastWriteError` (commit `d8b9b75`); `handleBroadcastError` now routes these to **502 POST_BROADCAST_FAILED** (`outcome:'confirmed'`), so they no longer hit the 504 path. Resolved.

2. **Pre-broadcast SYNC throws** — `PrivateKey.fromString(config.pevoAdminPostingKey)` at `backend/src/routes/orcid.ts:520` (handleAccredit) and `:610` (handleLink) on a malformed admin posting key, or `crypto.createHash` building `evidence_hash`. Still route through the wrapper catch as 504 `outcome:'uncertain'`. **No broadcast was attempted, so the outcome is *certain* (nothing happened) — yet the user is told to "verify your ORCID linkage at /settings before retrying" with nothing to verify, and operator alerts keyed on `<routeLabel> broadcast failed on ambiguous-outcome path` page broadcast-on-call when the actual root cause is admin-key configuration.**

The post-broadcast class above can hit different cascade throw types so a wrapper-level `instanceof` discriminator on PostBroadcastWriteError already exists. The pre-broadcast SYNC class is asymmetric: the only realistic trigger in production is `PrivateKey.fromString` rejecting the configured admin key. The configured key doesn't change at runtime — so the right place to catch a malformed key is at server boot, not inside the request lifecycle.

## Goal

Validate `config.pevoAdminPostingKey` (and `config.pevoBridgePostingKey` if it shares the same shape) at server startup, before `app.listen()` returns. A malformed key fails boot loudly with a config-error log line; the wrapper catch never sees a `PrivateKey.fromString` throw in production.

## Acceptance

1. **Startup validation.** Add a startup-time validator at `backend/src/index.ts` (or a small helper module) that calls `PrivateKey.fromString(config.pevoAdminPostingKey)` once and exits the process with a clear error if it throws. Apply the same check to `config.pevoBridgePostingKey` IF it is set (the bridge key is currently optional per existing 503 SERVICE_UNAVAILABLE guard at `claims.ts`; preserve the optional semantics — if unset, skip the check rather than failing boot).

2. **Error message.** The boot-failure log line should name the env var (`PEVO_ADMIN_POSTING_KEY` / `PEVO_BRIDGE_POSTING_KEY`) and the `dhive` error class. Operators reading the log should be able to recognize "key is malformed" without grepping the wrapper catch.

3. **Test.** Unit-level: import the validator, call it with `'invalid-wif'`, assert it throws/exits with a recognizable message. Skip integration-level tests — the production guard is "process exits before listening", which is hard to assert from a request-level test.

4. **Optional follow-up — not in this scope.** The `crypto.createHash` call building `evidence_hash` is also a pre-broadcast SYNC site, but a SHA-256 hash on `${orcidId}|${username}` is not a realistic throw target in Node.js (the hash never rejects on string inputs). Leave it.

## Non-goals

- Adding a new error class to `withOrcidBindingLock`. The wrapper's catch stays as-is — the goal is to ensure the only real-world trigger never fires in production. If a future class of pre-broadcast SYNC throws appears (e.g., a new operation that synchronously serializes an ORCID payload that could reject), file a new task discriminating it at the wrapper layer.
- Changing the wrapper catch envelope shape on the pre-broadcast SYNC path. Operators who see this 504 in production after this task ships have a deployed-but-unvalidated key; the operator-alert mislabel is then a deploy-time event, not a routine alert noise issue.

## Source

- `agents/docs/tasks/review/backend-orcid-acquired-branch-throw-guard.md` `/ce-code-review` 2026-04-28 — agent-native AN-001, reliability REL-001, adversarial adv-001.
- `backend/src/routes/orcid.ts:520` — `PrivateKey.fromString(config.pevoAdminPostingKey)` in `handleAccredit`.
- `backend/src/routes/orcid.ts:610` — same in `handleLink`.
- `backend/src/lib/broadcast-error.ts:14-18` — operator-alert anchor docblock; the third stable suffix `<routeLabel> broadcast failed on ambiguous-outcome path` is the one this task removes from the pre-broadcast SYNC trigger surface.

---

## Architect re-review (2026-04-30, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `cfa39b5`. The boot-time validator is correctly wired into `validateConfig()`, error message names env var + dhive class, empty-key carve-out preserves bridge-optional semantics, 5/5 unit tests pass. Two extensions surface from the review.

### Items to address

**1. (P1) Validator coverage map: `PrivateKey.fromString(config.X)` sites incomplete.** Cross-reviewer convergence (reliability + agent-native + learnings researcher all flagged this independently). The validator covers `PEVO_ADMIN_POSTING_KEY` + `PEVO_BRIDGE_POSTING_KEY`, but `PEVO_ANON_POSTING_KEY` is consumed via `PrivateKey.fromString` at `backend/src/routes/anonymousReview.ts:174` — same defect class but not covered by the boot validator. A malformed anon posting key would survive boot today; the same wrapper-catch mislabel this task closed for the admin path re-opens for the anonymous-review surface. Lower-severity than the admin path (anon is non-auth-critical and the catch returns a clean 500, not a 504 ambiguous-outcome misroute), but the same defect class.

Fix: extend `validatePostingKeyFormat` calls in `validateConfig()` to cover `PEVO_ANON_POSTING_KEY`. **Run `grep -rn "PrivateKey\\.fromString(config" backend/src/`** as the verification step (per the wrapping-primitive-exhaustive-call-site-audit convention — the implementer's signal block listing sites is a CLAIM, not evidence; the grep is the source of truth). Add or extend a unit test in `tests/startup-checks.test.ts` covering the new env var.

**2. (P3) Empty/whitespace `config.hiveBridgeAccount` validator.** Adversarial reviewer surfaced (during cluster 1 bridge-paper review): `HIVE_BRIDGE_ACCOUNT='   '` would silently exclude all bridge papers across every PEvO surface via `validPevoPaperWhere`'s author pin. Extend `startup-checks.ts` to reject empty/whitespace values for `HIVE_BRIDGE_ACCOUNT` (and analogous account-name env vars: `HIVE_ADMIN_ACCOUNT`, `HIVE_ONBOARD_ACCOUNT`, `HIVE_ANON_ACCOUNT` — verify the full list during implementation). Reasonable shape: a `validateAccountNameFormat(value, envVar)` helper that runs `Hive`'s standard account-name regex (`^[a-z][a-z0-9.-]{2,15}$` or whatever dhive exposes) and rejects blanks.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit.

---

## Backend re-review signal (2026-04-30, working tree)

Round-2 hold-fix items 1 and 2 landed. Round-1 commit `cfa39b5` not retouched.

### Item 1 — `PEVO_ANON_POSTING_KEY` boot validator

Extended `validateConfig()` in `backend/src/startup-checks.ts` to call `validatePostingKeyFormat(config.pevoAnonPostingKey, 'PEVO_ANON_POSTING_KEY')` alongside the existing admin/bridge calls. The optional semantics (skip if unset, fail boot if set-but-malformed) match admin/bridge — `pevoAnonPostingKey` is sourced via `process.env.PEVO_ANON_POSTING_KEY || ''` in `config.ts:51`, identical to admin's optional-with-empty-fallback shape. Added inline comment listing the verified coverage map (admin/bridge/anon).

Verification grep (`grep -rn "PrivateKey\\.fromString(config" backend/src/`):

```
backend/src/wot.ts:232:      PrivateKey.fromString(config.pevoAdminPostingKey),
backend/src/wot.ts:361:          PrivateKey.fromString(config.pevoAdminPostingKey),
backend/src/routes/anonymousReview.ts:174:    const key = PrivateKey.fromString(config.pevoAnonPostingKey);
backend/src/routes/papers.ts:1509:    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
backend/src/routes/bridge.ts:233:    const key = PrivateKey.fromString(config.pevoBridgePostingKey);
backend/src/routes/bridge.ts:362:    const key = PrivateKey.fromString(config.pevoBridgePostingKey);
backend/src/routes/signup-verify.ts:287:        const adminKey = PrivateKey.fromString(config.pevoAdminPostingKey);
backend/src/routes/signup-verify.ts:415:        const adminKey = PrivateKey.fromString(config.pevoAdminPostingKey);
backend/src/routes/accreditation.ts:350:    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
backend/src/routes/claims.ts:214:    const key = PrivateKey.fromString(config.pevoBridgePostingKey);
backend/src/routes/claims.ts:311:    const key = PrivateKey.fromString(config.pevoBridgePostingKey);
backend/src/routes/claims.ts:347:    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
backend/src/routes/orcid.ts:585:    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
backend/src/routes/orcid.ts:757:    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
```

Three distinct config-sourced keys; all three are now boot-validated.

Test added: `tests/startup-checks.test.ts` — `validates PEVO_ANON_POSTING_KEY (round-2 coverage gap)` covers unset-OK, valid-WIF-OK, malformed-rejected with env-var name in the error message.

### Item 2 — `validateAccountNameFormat` for `HIVE_*_ACCOUNT` vars

Added `validateAccountNameFormat(value, envVar)` helper to `backend/src/startup-checks.ts`. Rejects empty/whitespace and applies the literal regex `/^[a-z][a-z0-9.-]{2,15}$/` (matches the existing precedent at `backend/src/routes/anonymousReview.ts:147` — dhive does not export an account-name validator). Wired into `validateConfig()` over the resolved config values (not `process.env.*`) so a `HIVE_BRIDGE_ACCOUNT='   '` deploy that survives the `||` fallback in `config.ts` is caught at boot.

Account-name env var list derived from `backend/src/config.ts` (lines 16, 17, 55, 98):
- `HIVE_ADMIN_ACCOUNT` → `config.hiveAdminAccount` (default `'pevo.admin'`)
- `HIVE_BRIDGE_ACCOUNT` → `config.hiveBridgeAccount` (default `hiveAdminAccount`)
- `HIVE_ONBOARD_ACCOUNT` → `config.hiveOnboardAccount` (default `hiveAdminAccount`)
- `HIVE_ANON_ACCOUNT` → `config.hiveAnonAccount` (default `'pevo.anon'`)

All four are validated. No other `HIVE_*_ACCOUNT` env vars surfaced in the grep.

Tests added (10 new): unset-OK, valid-name (dotted + plain + hyphenated), whitespace-only rejected, single-space rejected (canonical adversarial case), uppercase rejected, too-short (<3), too-long (>16), digit-start rejected, special chars (`_`, `$`, space) rejected, env-var name passthrough.

### Verification

- `npx tsc --noEmit` — clean (no output).
- `npm run lint` — clean (only pre-existing `seed-phrase.ts` `any` warnings, unrelated).
- `npx vitest run tests/startup-checks.test.ts` (with docker-network Redis/Postgres IPs per root CLAUDE.md) — 16 passed (5 round-1 + 1 round-2 anon + 10 round-2 account-name), 0 failed, 858ms.

Commit SHA: filled in at commit time (this paragraph and the SHA below land in the same commit).

---

## Architect re-review (2026-05-01, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `4f9d454`. Round-2 anon-key + account-name validators correctly extend the round-1 boot guard. The three posting-key call sites (admin/bridge/anon) are now boot-validated; the four `HIVE_*_ACCOUNT` resolved-config values are validated; tests cover both helpers in isolation. Six items surface from the round-2 commit review.

### Items to address

**1. (P3) Account-name regex permits canonically-invalid Hive names — defeats item 2's stated purpose.** Cross-reviewer convergence (correctness + testing + security + adversarial + project-standards, 5-way → conf 100). Regex `/^[a-z][a-z0-9.-]{2,15}$/` accepts `'pevo.'` (trailing dot), `'a..b'` (consecutive dots), `'a-bc-'` (trailing hyphen), `'.abc'` — adversarial-verified empirically. `HIVE_BRIDGE_ACCOUNT='pevo.'` boots clean and silently mismatches every chain query via `validPevoPaperWhere`'s author pin — the exact silent-zero-rows failure mode item 2 was filed to prevent. The convention parity with `routes/anonymousReview.ts:147` precedent is intentional, but that precedent guards a different surface (sanitizing already-on-chain user-supplied authors against SQL injection — values canonical-by-construction, not deploy-time configuration).

Fix: tighten the regex to Hive's canonical account-name shape — segments separated by `.` where each segment matches `[a-z][a-z0-9-]*` and each segment is 3-16 chars total (overall account name ≤ 16 chars per Hive's witness-imposed limit) — OR document the gap explicitly in the docblock as accepted convention parity. Implementer's call. If tightening, recommend landing it inside the shared constant from item 5 below so the canonical pattern lives in one place.

**2. (P2) `validateConfig` comment hardcodes a frozen grep snapshot of consumer files.** Cross-reviewer convergence (maintainability + adversarial, 2-way → conf 100). Lines 107-110 of `backend/src/startup-checks.ts` list "Coverage map (verified via grep)" enumerating consumer files (orcid, accreditation, papers, claims, signup-verify, wot, bridge, anonymousReview). The list will rot the moment a new file consumes one of the 3 keys — and a future site that breaks `PrivateKey.fromString(config.X)` across two lines wouldn't even match the literal grep. The comment claims authority a reader will trust 6 months from now even when stale.

Fix: collapse to a one-liner referencing the re-runnable command and the COUNT (no consumer-file list) — e.g., "Coverage: 3 distinct config keys (admin/bridge/anon); re-derive the call-site map via `grep -rn 'PrivateKey\.fromString(config' backend/src/`." OR convert the coverage assertion to a unit-style spec that imports a module-level `BOOT_VALIDATED_KEYS` constant and asserts every grep'd consumer key is in the set.

**3. (P3) `BLOG_AUTHOR` env var is a Hive account name but not boot-validated.** Single-reviewer (reliability) conf 75. `config.blogAuthor` (default `'pevo.science'`) is consumed as a Hive account name in `routes/blog.ts:36` (getDiscussions tag) and `:74` (get_content first arg) — same defect class as `HIVE_BRIDGE_ACCOUNT`: blank/malformed value silently returns empty blog listings or 404s with no boot-time signal.

Fix: add `BLOG_AUTHOR` to the `accountChecks` array in `validateConfig`. Re-run `grep -rn "config\.\w*Account\b\|config\.blogAuthor" backend/src/` to confirm no other Hive-account-name configs are missing from the validator (e.g., scan for any future `config.fooAccount` style fields), then add a one-line item to the round-3 signal block listing the verified set.

**4. (P3) Operator-grep error-message asymmetry between WIF whitespace and account-name whitespace.** Single-reviewer (adversarial) conf 75. `validateAccountNameFormat` whitespace input gets a recognizable `'empty or whitespace-only'` message; `validatePostingKeyFormat` whitespace input falls through to dhive's generic `'Non-base58 character'`, leading operators to misdiagnose copy-paste artifacts as key corruption.

Fix: mirror the `.trim()` guard from `validateAccountNameFormat` into `validatePostingKeyFormat` — emit a recognizable "empty or whitespace-only value" message before dhive sees the bad input. Add a unit test for whitespace WIF input asserting the message recognizable substring.

**5. (P2) Hive account-name regex `/^[a-z][a-z0-9.-]{2,15}$/` duplicated 3+ sites.** Single-reviewer (maintainability) conf 75. Now lives in `backend/src/startup-checks.ts:61`, `backend/src/routes/anonymousReview.ts:147`, with a near-miss variant at `backend/src/routes/signup-verify.ts:29` (`{1,14}` + trailing `[a-z0-9]`) and a fourth shape in the frontend. The new validator's docblock explicitly says it copies the precedent — that's the textbook signal to extract a shared constant before a third copy lands.

Fix: extract `HIVE_ACCOUNT_NAME_REGEX` (and any companion regex if item 1 chooses tightening) to a new `backend/src/lib/hive-account-name.ts`; update `startup-checks.ts:61` and `routes/anonymousReview.ts:147` to import. Leave `signup-verify.ts:29` as-is (different intent — username-availability check on sign-up, not config validation) unless the implementer judges the patterns should converge.

**6. (P3) Test coverage gaps for the round-2 helpers.** Single-reviewer (testing); two distinct gaps:
   - **6a:** Round-2 anon-key spec at `tests/startup-checks.test.ts:41-52` omits the dhive error-class assertion that round-1 admin/bridge specs pin. Fix: add `expect(malformedErr).toContain('Error')` and a dhive class hint (e.g., `'Non-base58 character'`) to mirror round-1 rigor.
   - **6b:** No length-boundary acceptance tests for `validateAccountNameFormat`. Tests assert rejection at 2 (`'ab'`) and 17 (`'a'.repeat(17)`) but no acceptance at inclusive boundaries 3 (`'abc'`) and 16 (`'a'.repeat(16)`). A future off-by-one regex tweak (`{3,15}` or `{2,14}`) would slip through. Fix: add the two missing boundary acceptance specs.

### Re-review signal

When items 1-6 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

---

## Backend re-review signal (2026-05-04, working tree)

Round-3 hold-fix items 1-6 landed.

### Item 1 — Canonical Hive account-name regex

Tightened from the legacy `/^[a-z][a-z0-9.-]{2,15}$/` to Hive's canonical witness shape: dot-separated segments, each `[a-z][a-z0-9-]*[a-z0-9]` of length 3-16, with overall length capped at 16 chars by a negative lookahead `(?!.{17,})`. The new constant lives in the new shared lib (item 5):

```
HIVE_ACCOUNT_NAME_REGEX = /^(?!.{17,})[a-z][a-z0-9-]{1,14}[a-z0-9](\.[a-z][a-z0-9-]{1,14}[a-z0-9])*$/
```

Empirical verification against PEvO defaults + adversarial cases (sanity script run during this round):

```
"pevo.science"       PASS    (BLOG_AUTHOR default)
"pevo.admin"         PASS    (HIVE_ADMIN_ACCOUNT default)
"pevo.bridge"        PASS
"pevo.anon"          PASS    (HIVE_ANON_ACCOUNT default)
"pevo.onboard"       PASS
"abc" / "bob"        PASS    (3-char minimum boundary)
"a"*16               PASS    (16-char maximum boundary)
"a"*17               FAIL    (17-char overflow)
"pevo."              FAIL    (trailing dot)
"pevo.ab"            FAIL    (segment <3 chars)
"foo..bar"           FAIL    (consecutive dots)
"a-bc-"              FAIL    (trailing hyphen)
".abc"               FAIL    (leading dot)
"1abc"               FAIL    (digit start)
"ABC"                FAIL    (uppercase)
"pe vo"              FAIL    (whitespace)
"pevo_admin"         FAIL    (underscore)
```

### Item 2 — Coverage-map comment collapsed

Replaced the consumer-file enumeration with a one-liner referencing the re-runnable grep + the COUNT (3 distinct config-sourced posting-key fields). Same shape applied to the parallel comment block above the `accountChecks` array (5 distinct account-name fields after item 3 added `BLOG_AUTHOR`).

### Item 3 — `BLOG_AUTHOR` added to `accountChecks`

Added `{ value: config.blogAuthor, envVar: 'BLOG_AUTHOR' }` to the `accountChecks` array. Verified via `grep -rn "config\.\w*Account\b\|config\.blogAuthor" backend/src/` that the resolved set covers all current Hive-account-name-shaped config fields:

```
config.hiveAdminAccount    → HIVE_ADMIN_ACCOUNT     (validated)
config.hiveBridgeAccount   → HIVE_BRIDGE_ACCOUNT    (validated)
config.hiveOnboardAccount  → HIVE_ONBOARD_ACCOUNT   (validated)
config.hiveAnonAccount     → HIVE_ANON_ACCOUNT      (validated)
config.blogAuthor          → BLOG_AUTHOR            (validated, this round)
```

No other `config.*Account` or analogous Hive-name-shaped fields surfaced.

### Item 4 — `.trim()` guard mirrored into `validatePostingKeyFormat`

Added an explicit `if (!value.trim()) return ...` check before the dhive `PrivateKey.fromString` call. Whitespace-only WIF inputs now emit a recognizable `"empty or whitespace-only value (likely a copy-paste artifact; check the key was pasted without a leading/trailing space)"` message instead of dhive's generic `'Non-base58 character'`. Two new unit specs cover the whitespace-input case (`'   '`, `' '`).

### Item 5 — `HIVE_ACCOUNT_NAME_REGEX` extracted to shared lib

New file `backend/src/lib/hive-account-name.ts` defines the canonical regex with a docblock explaining: (a) Hive's witness-imposed account-name rules (per-segment 3-16, overall ≤ 16, last char must be alphanumeric); (b) why the legacy regex was a defect class (silent-zero-rows on author-pinned queries); (c) the import map (startup-checks.ts, anonymousReview.ts) and the deliberate non-import (signup-verify.ts:29 — different intent: username-availability with stricter-trailing-char rule on a single segment).

`startup-checks.ts:61` and `routes/anonymousReview.ts:147` updated to import the constant. `signup-verify.ts:29` left as-is per the architect's hold note.

### Item 6 — Test coverage gaps closed

- **6a:** Added `expect(malformedErr).toContain('Error')` + `expect(malformedErr).toContain('Non-base58 character')` to the round-2 anon-key spec at `tests/startup-checks.test.ts:42-57` to mirror round-1 admin/bridge rigor.
- **6b:** Added two boundary-acceptance specs at the inclusive boundaries: `'abc'` (3 chars) and `'a'.repeat(16)` (16 chars). Plus 5 bonus specs covering the canonical-shape rejections from item 1 (`pevo.`, `foo..bar`, `a-bc-`, `.abc`, `pevo.ab`) so a future regex tweak that re-permits any of the canonical-invalid shapes fails loudly.

### Verification

- `npx tsc --noEmit` from `backend/` — clean.
- `npm run lint` — clean (only pre-existing `seed-phrase.ts` `any` warnings, unrelated).
- `npx vitest run tests/startup-checks.test.ts` — 25 passed (16 round-1+2 + 9 round-3), 0 failed, 835ms.

### Files changed (this round)

- `backend/src/lib/hive-account-name.ts` — NEW, defines `HIVE_ACCOUNT_NAME_REGEX` + docblock.
- `backend/src/startup-checks.ts` — `validatePostingKeyFormat` `.trim()` guard (item 4); `validateAccountNameFormat` regex tighten via shared constant (item 1); coverage-map comments collapsed (item 2); `BLOG_AUTHOR` added to `accountChecks` (item 3).
- `backend/src/routes/anonymousReview.ts` — replaced inline regex literal with `HIVE_ACCOUNT_NAME_REGEX` import (item 5).
- `backend/tests/startup-checks.test.ts` — round-3 anon-key dhive-class hint + whitespace WIF + boundary acceptance + canonical-shape rejections (items 6a, 6b, 4, 1).

---

## Architect re-review (2026-05-16, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` ran on commit `3dc56ba` with 9 reviewers (correctness, testing, maintainability, project-standards, learnings-researcher, security, reliability, adversarial, kieran-typescript; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). Round-3 hold items 1-6 landed correctly: regex is canonical, `.trim()` guard ordering is right, BLOG_AUTHOR wiring uses resolved config, tests cover the new boundaries, signup-verify.ts left as-is matches the docblock claim. Verification grep confirmed no lingering inline copies of the legacy `[a-z][a-z0-9.-]{2,15}` pattern outside the documented signup-verify.ts non-import (which uses a different shape with BAD_SEGMENT_RE companion). One item surfaces from the round-3 commit review.

### Items to address

**1. (P2) Docblock import map in the new shared lib reintroduces the same frozen-snapshot rot that round-2 item 2 was filed to remove.** Cross-reviewer convergence (maintainability M1 + learnings-researcher L5 — `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`). `backend/src/lib/hive-account-name.ts` lines 32-38 contain two rot-prone blocks:

```
 * Single source of truth — imported by:
 *   - `startup-checks.ts` (validateAccountNameFormat — boot-time deploy validation)
 *   - `routes/anonymousReview.ts` (sanitizing already-on-chain user-supplied authors)
 *
 * NOT imported by `routes/signup-verify.ts:29` — that pattern guards a different
 * surface (username-availability check on sign-up, with a stricter
 * "ends in [a-z0-9]" rule applied to a single segment without dot-separation).
```

Two problems:
- A third consumer in the future leaves the list incomplete with no signal — exactly the rot class round-2 item 2 already closed for `validateConfig`'s coverage-map comment, just on a different file.
- Empirical: the `:29` line-number anchor is **already wrong on landing**. Verified by `grep -n USERNAME_RE backend/src/routes/signup-verify.ts` → `USERNAME_RE` is at line 37, not line 29. The docblock baked in a stale line number from the architect's round-2 hold note that referenced an older revision. This is the textbook rot signature the learnings doc above is filed against.

Fix: delete lines 32-38 of the docblock (the `Single source of truth — imported by:` block AND the `NOT imported by routes/signup-verify.ts:29` callout). The module name and export name already communicate purpose. The Hive consensus rules block (lines 1-25) and the regex explanation (lines 35-41 — currently the second `/** ... */` block above the `export const`) stay; those are genuinely useful and not rot-prone. Anyone wanting the consumer map runs `grep -rn HIVE_ACCOUNT_NAME_REGEX backend/src/`. This matches the round-2 item 2 resolution shape exactly (one-liner + re-runnable grep reference). Comment-only change; no test updates needed.

### Dismissed at architect triage (no implementer action)

- **testing T1 (P2) — no route-level test for the regex tightening at `routes/anonymousReview.ts:149`.** Dismissed per `feedback_dismiss_preemptive_test_hardening.md`: the cited failure mode ("a future revert of the import would not break any existing test") is preemptive hardening against a hypothetical regression. The shared `HIVE_ACCOUNT_NAME_REGEX` constant is pinned by `tests/startup-checks.test.ts`; the route wiring is verifiable from the import line. The behavior change at the route is real but defensive route-level coverage against a hypothetical revert does not clear the project's preemptive-hardening bar.
- **kieran-typescript KT-1 (P2, anchor 50) — `string | null` not narrowed after `expect(...).not.toBeNull()` in test file.** Suppressed by confidence gate. No runtime impact; only a refactor-risk type hole that vitest's `expect(unknown)` absorbs silently.
- **adversarial (P3 advisory, anchor 50) — stricter regex on POST /anonymous is a strict contract narrowing.** Routed to residual_risks per advisory class: real Hive on-chain authors cannot produce the newly-rejected shapes (Hive consensus enforces canonical account-name rules at chain level), so practical impact is nil.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Round-4 architect review scopes `/ce-code-review` to the round-4 commit only.

---

## Backend re-review signal (2026-05-16, working tree)

Round-4 hold-fix item 1 landed.

### Item 1 — Rot-prone import-map block removed from `hive-account-name.ts` docblock

Deleted the `Single source of truth — imported by:` paragraph AND the `NOT imported by routes/signup-verify.ts:29` callout from `backend/src/lib/hive-account-name.ts`. The Hive consensus rules block (lines 1-25) and the `HIVE_ACCOUNT_NAME_REGEX` explanation block (now lines 27-33) stay — those are not rot-prone.

Empirical confirmation of the stale-anchor claim: `grep -n USERNAME_RE backend/src/routes/signup-verify.ts` returned line 37, not line 29 — the deleted callout was already wrong on landing, exactly as the architect's hold note flagged.

Future readers wanting the consumer map run `grep -rn HIVE_ACCOUNT_NAME_REGEX backend/src/`. Matches the round-2 item 2 resolution shape (one-liner + re-runnable grep reference).

### Verification

- `npx tsc --noEmit` from `backend/` — clean (no output).
- `npm run lint` — clean (only pre-existing `seed-phrase.ts` `any` warnings, unrelated).
- `npx vitest run tests/startup-checks.test.ts` (with docker-network Redis/Postgres IPs per root CLAUDE.md) — 42 passed, 0 failed, 910ms. The error-log lines in test output are the round-1/2 boot-failure paths under assertion; the `Tests  42 passed (42)` line is the summary.

### Files changed (this round)

- `backend/src/lib/hive-account-name.ts` — deleted 7-line import-map block from the leading docblock (item 1). No other edits.

---

## Architect re-review (2026-05-21, round-4 → round-5) — HELD PENDING FIXES

`/ce-code-review` on the round-4 commit ran with always-on personas + learnings. The round-4 deletion correctly removes the cited rot (import-map block + `:29` line-number anchor). The remaining docblock anchors on stable symbols (`validPevoPaperWhere`, `config.hiveBridgeAccount`, `HIVE_ACCOUNT_NAME_REGEX`) and a stable external path. One sibling-rot item held — same convention class as the round-4 deletion, in the same docblock, missed by the sweep.

### Item held (must fix before archive)

**1. (P3, conf 75, cross-reviewer — maintainability + project-standards) "legacy round-2 regex" round-N qualifier in `backend/src/lib/hive-account-name.ts`'s leading docblock.** The phrase `The legacy round-2 regex` survives in the same docblock the round-4 commit edited. Per root CLAUDE.md "Comment anchors" and `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, round numbers in production/test source are a named rot class. Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the round-4 sweep should have audited adjacent comments in the same docblock for related rot.

Fix: rewrite to anchor on the historical pattern itself rather than the coordination round. E.g., `An earlier regex `/^[a-z][a-z0-9.-]{2,15}$/` accepted canonically-invalid names...` — the literal pattern is the durable anchor for the rot-class being explained. Pure comment-only edit.

Audit-own-replacement check: the replacement text must not introduce a different rot class (no slug, no SHA, no line-number anchor, no round-N marker).

### Items dismissed at architect triage

- The round-4 deletion is complete and correct as scoped; the held item is a sibling-rot pickup, not a defect in round-4's work.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Round-5 architect review scopes `/ce-code-review` to the round-5 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

---

## Backend re-review signal (2026-05-25, working tree)

Round-5 hold-fix item 1 landed.

### Item 1 — round-N qualifier removed from `hive-account-name.ts` leading docblock

Rewrote `The legacy round-2 regex `/^[a-z][a-z0-9.-]{2,15}$/`...` to `An earlier regex `/^[a-z][a-z0-9.-]{2,15}$/`...`. The durable anchor is now the literal historical pattern itself, not the coordination round. The surrounding text (the canonically-invalid example names and the `validPevoPaperWhere` silent-zero-rows rationale) was already anchored on stable symbols and stays.

Audit-own-replacement check: the replacement introduces no slug, SHA, line-number anchor, or round-N marker — it names only the literal regex pattern.

### Verification

- Comment-only edit; no behavior change, no test impact.
- `npx tsc --noEmit` from `backend/` — clean.
- `npm run lint` — clean (only pre-existing `seed-phrase.ts` `any` warnings, unrelated).

### Files changed (this round)

- `backend/src/lib/hive-account-name.ts` — one-line docblock phrase rewrite (item 1). No other edits.

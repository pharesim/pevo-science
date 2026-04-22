# BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING — Reorder /signup checks so duplicate-email fires before institutional-email gate, closing the 422-vs-409 timing oracle

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-LOGIN-UNKNOWN-USER-TIMING round-2 review 2026-04-22)
**Priority:** P2

## Context

`BE-LOGIN-UNKNOWN-USER-TIMING` round-2 added a burnSentinel call to the /signup 409 DUPLICATE early-return path. Re-review flagged that this only equalizes the 409-vs-201 timing on /signup; it does not close the **422 ACCREDITATION_NOT_FOUND vs 409 DUPLICATE** timing oracle.

Current /signup check order at `backend/src/routes/auth.ts:~130-200`:
1. Validation: email format, password strength, etc.
2. Accreditation gate: `isInstitutionalEmail(email)` → pure synchronous function → 422 in ~0ms if the domain is not institutional.
3. Duplicate-email check: DB query + burnSentinel on 409 → ~50ms.
4. Happy path: argon2.hash + SMTP → ~100ms + SMTP.

Result matrix (email / domain → response timing):
- Unknown-institution + any email → 422 in ~0ms
- Known-institution + unknown-email → happy path → ~100ms + SMTP
- Known-institution + known-email → 409 in ~50ms (burnSentinel)

An attacker submitting `?email=target@mit.edu` distinguishes registered accounts on accredited institutions: ~50ms 409 means registered, anything else means not. `mit.edu`, `harvard.edu`, and other known-institutional domains are public knowledge, so restricting enumeration to accredited domains does not meaningfully slow the attack.

## User decision (architect/user triage 2026-04-22)

**Equalize via gate reorder.** The chosen approach is to swap the check order so the duplicate-email check runs **before** the accreditation gate. Both branches then emit 409 (duplicate) or 422 (accreditation missing) through the burnSentinel-equalized ~50ms path, and unknown-email + unknown-institution still short-circuits fast — but so does unknown-email + known-institution, removing the distinguishing signal on registration status.

Behavior change note: an unaccredited-institution user submitting a duplicate email previously got 422 ACCREDITATION_NOT_FOUND (unhelpful — they can't sign up anyway so the accreditation message is beside the point); post-reorder they get 409 DUPLICATE (more accurate about their email state). Neither path lets them sign up. The UX regression is minor (wrong error for a doubly-blocked user); the privacy win is material (no registration-status enumeration via institution-probing).

## Goal

1. Reorder the /signup check sequence at `auth.ts:~130-200` to: validation → duplicate-email (with existing burnSentinel on 409) → accreditation gate → happy path.
2. Ensure the 422 ACCREDITATION_NOT_FOUND path on a non-duplicate email still returns fast (~0ms) — that's the intended behavior since knowing the domain is unaccredited is public knowledge, not user-specific info. The oracle being closed is registration-status, not institution-status.
3. Add a timing test asserting that for a known-duplicate email, both unaccredited-domain and accredited-domain 409 responses take ≥40ms (proves reorder landed and burnSentinel still fires before institution gate).

## Non-goals

- Adding a burnSentinel to the 422 path. Institution-membership is public; equalizing 422 timing would hide public info for no gain.
- Changing the 422 error code or message.
- Reshaping the /signup contract. `api-contracts/auth.md` may need a note that duplicate-check fires before accreditation gate; architect updates per the new contract-edit boundary rule in `backend/CLAUDE.md`.

## Acceptance

- /signup dispatches checks in the new order (validation → duplicate → accreditation → happy path).
- Timing test: accredited-duplicate 409 ≥40ms; unaccredited-duplicate 409 ≥40ms (new assertion). Existing 422 path timing unchanged.
- Full backend vitest clean; `npx tsc --noEmit` clean.

## [TODO Architect]

- Update `agents/docs/api-contracts/auth.md` /signup section to document the reordered semantics: duplicate-email check is now authoritative across all institutional/non-institutional callers. Backend agent leaves a [TODO Architect] note on the re-review signal; architect edits misc.md / auth.md during archive per the boundary rule.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `34580a6` (correctness, security, testing, adversarial). The reorder is correct; timing test mutation-kill is strong on both the burn and the gate-order mutations; the UX regression (unaccredited-duplicate 409 instead of 422) is correctly tested. One hold item plus several P3s. Architect-owned contract update (auth.md:81) is applied in-place during this review pass.

1. **P2 — 422 non-duplicate unaccredited path has no test** (testing T1 0.88). The gate moved to a new code position. No test sends a fresh gmail-style address to `/api/auth/signup` and asserts 422 + fast elapsed time. The fast-exit 422 branch is a behavioral change from the reorder; it needs a test to lock in the "accredited institution membership is public knowledge; fast-return on 422 is intentional" contract. Fix: add one spec hitting a non-duplicate gmail-style address, assert `res.status === 422` AND `elapsed < TIMING_ORACLE_CEILING_MS` (or similar ceiling constant confirming no argon2 path was taken).

**Dismissed from round-1 findings (architect triage):**
- **P3** hasPassword=false ORCID-duplicate cell untested (testing T2 0.82): lower-priority matrix cell; fold into hold-fix commit if convenient.
- **P3** Missing TIMING_ORACLE_CEILING_MS upper-bound on new timing test (testing T3 0.75): fold into hold-fix.
- **P3** ORCID-only no-email signup has no uniqueness guard (correctness RR13-2): pre-existing gap, not introduced.
- **P3** "Public knowledge" claim thinner for configured INSTITUTIONAL_EMAIL_DOMAINS (security RR13-1): gov/corporate accreditations in allowlist are not publicly audited. Document in security posture notes or file follow-up if operationally relevant.
- **P3** Unverified pending row on unaccredited domain coverage gap (security): falls through to upsert → 422. Correct behavior; acceptable.
- **P3** ORCID+email+no-password duplicate skips argon2 burn (correctness C13-2 0.61 info): intentional per `hasPassword` gate; add inline comment explaining the asymmetry.

**Architect-owned fix-in-place (applied in this review pass):**
- `agents/docs/api-contracts/auth.md:81` — update the 422 clause so it documents the post-reorder semantics (422 applies only to non-duplicate unaccredited callers; duplicate-email 409 is authoritative regardless of institution).

**Path to re-archive:** (1) Backend applies item #1 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2; archives on clean.

---

**Backend re-review signal (2026-04-22, commit pending):**

Round-1 hold fix landed. Changes:

- **P2 (required)** — Added `BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING: 422 on non-duplicate unaccredited email is fast` describe block to `backend/tests/routes/recover.test.ts`. One spec posts a fresh `signup_422_fresh_${Date.now()}@gmail.com` address with a valid password and the standard signup shape, then asserts `res.status === 422`, `res.body.error.code === 'VALIDATION_ERROR'`, and `elapsed < TIMING_ORACLE_CEILING_MS` (150ms, the existing constant at `recover.test.ts:71`). Observed runtime on the new spec: ~2ms for the 422 response (logged `responseTime:2`), well under the 150ms ceiling. Mutation-kills: adding `burnSentinel` or `argon2.hash` to the 422 path would push `elapsed` past 150ms and fail the upper-bound assertion, locking in the intended "institution membership is public, fast-return is fine" contract.
- **P3 T3 folded in** — Added `expect(accElapsed).toBeLessThan(TIMING_ORACLE_CEILING_MS)` and `expect(unaccElapsed).toBeLessThan(TIMING_ORACLE_CEILING_MS)` to the existing duplicate-gate-ordering timing test (recover.test.ts ~line 1148). Upper-bound mutation-kill: a regression that layers `burnSentinel` on top of `argon2.hash` would push elapsed past 150ms.
- **P3 T2 skipped** — The hasPassword=false ORCID-duplicate cell test requires new scaffolding (seeded ORCID-only account + a valid ORCID verification token path, because `verifiedOrcid` depends on an upstream token exchange). The hold block marked this "fold in if convenient"; it isn't, so skipped.
- **P3 C13-2 skipped** — The `hasPassword` gate inline comment asymmetry is already covered by the block comment at `auth.ts:306-309` ("Gate on hasPassword to avoid paying argon2 cost on ORCID+email signup with no password — both 409 and happy-path are ~1ms there, no oracle to close"). Adding another inline comment would duplicate the existing rationale.

Verification:
- `npx tsc --noEmit` — clean (no output).
- `npx vitest run tests/routes/recover.test.ts` — 28/28 passing against real Redis + Postgres (Docker network IPs).

Parent will `git mv` this file to `tasks/review/` on merge.

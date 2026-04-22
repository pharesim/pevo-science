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

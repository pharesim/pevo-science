# BACKEND-CONSENT-OP-FIELD-NORMALIZATION-PARITY — converge consent-op field reads on one shared trim+cap reader

**Owner:** backend
**Created:** 2026-06-10 (architect, from the round-3 `/ce-code-review` of `backend-authorship-credit-ops-fresh-auth`; adversarial conf-100, corroborated by correctness + security)
**Priority:** P3 (pre-existing fail-closed asymmetry; no exploit, no current defect)

## Problem

The credit-op fresh-auth fields are normalized through one shared reader (`extractCreditOpFields` in `backend/src/lib/fresh-auth.ts`: trim + length cap, identical at both issuance paths and the broadcast consume scan). The CONSENT ops (`author_accept` / `author_resign`) still carry the asymmetry that work eliminated for credit ops:

- the orcid `/start` consent branch (`backend/src/routes/orcid.ts`) validates `root_author` / `root_permlink` with bare typeof/length checks — no trim, no cap (uncapped values flow into the ORCID Redis state);
- the custody `/fresh-auth` consent issuance trims + caps via `requireStringField(..., { trim: true })`;
- the broadcast consume side (`consentOpTarget` in `backend/src/routes/custody.ts`) hashes the raw payload values.

Consequence: a whitespace-padded consent-op field hashes differently between issuance and consume depending on the mechanism — fail-closed (self-inflicted `target_mismatch` 403; the ORCID path succeeds where the password path fails on the same input), plus uncapped input into Redis. Same defect class as the credit-op convergence; low real-world probability (valid Hive identifiers carry no whitespace).

## Goal

Mirror the credit-op fix shape: one shared consent-op field reader (an `extractConsentOpFields`, or shared `requireStringField` plumbing with one cap/trim config) used by all three consent-op field-read sites: the orcid `/start` consent branch, the custody `/fresh-auth` consent issuance, and the broadcast consume scan (`consentOpTarget`), so issuance and consume normalize identically before hashing.

## Acceptance

- All three consent-op field-read sites normalize identically before hashing; a padded-field extraction hashes identically to a clean one (unit-pinned, mirroring the credit-op padded≡clean test).
- Backward-compat: a well-formed (unpadded, in-cap) consent-op proof issued before this change still consumes — hash inputs for clean values are unchanged.
- Existing consent-op suites stay green; `npm run typecheck` + `npm run lint` clean.
- Comment anchors clean (stable symbols only; no slug/round/line/SHA).

## Cross-references

- `backend/src/lib/fresh-auth.ts` — `extractCreditOpFields`, `requireStringField` (the proven fix shape).
- `backend/src/routes/custody.ts` — `consentOpTarget`, the `/fresh-auth` consent branch.
- `backend/src/routes/orcid.ts` — the `/start` `mode=fresh_auth` consent branch.
- Parent: `backend-authorship-credit-ops-fresh-auth` (the credit-op convergence this mirrors).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

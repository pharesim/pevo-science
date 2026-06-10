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

## Implementation note (backend, 2026-06-10)

Mirrored the credit-op fix shape exactly:

- `backend/src/lib/fresh-auth.ts`: added `CONSENT_OP_ACCOUNT_MAX_LEN` (64; separate constant from `CREDIT_OP_ACCOUNT_MAX_LEN` because the op families carry deliberately distinct wire fields and validation surfaces), `ConsentOpTargetFields` (no per-action discrimination — both consent actions carry the same two fields, so no exhaustiveness backstop is needed, unlike the credit extractor), `consentOpFreshAuthTarget` (builds the original `(action, root_author, root_permlink)` triple, byte-identical to the inline literals it replaces), and `extractConsentOpFields` (trim + cap via `requireStringField`: `root_author` at `CONSENT_OP_ACCOUNT_MAX_LEN`, `root_permlink` at `HIVE_PERMLINK_MAX_LEN`).
- `backend/src/routes/custody.ts`: `consentOpTarget` (broadcast consume scan) now delegates to the shared extractor + builder, mirroring `creditOpTarget`; the custody-local `readRequiredString` helper became orphaned and was removed. The `/fresh-auth` consent issuance reads through the extractor (its previous inline `requireStringField` pair removed). The pre-limiter `validateFreshAuthBodyShape` consent branch caps `root_author` with the imported `CONSENT_OP_ACCOUNT_MAX_LEN`; the now-unused custody-local `ROOT_AUTHOR_MAX_LEN` was removed (same linkage shape as the credit-op round-3 cap fix).
- `backend/src/routes/orcid.ts`: the `/start` `mode=fresh_auth` consent branch routes through `extractConsentOpFields` + `consentOpFreshAuthTarget`, replacing the bare typeof/length checks (no trim, no cap); the now-unused `rootAuthor`/`rootPermlink` destructure bindings were dropped. Error message for a malformed field is the extractor-shaped `"<field> is missing or invalid"` (message strings are not contract surface; SPA branches on `error.code`, per the parent task's round-3 dismissal).
- Tests (`backend/tests/lib/fresh-auth.test.ts`): new `extractConsentOpFields` describe block — both-actions happy path, padded≡clean hash pin (the acceptance-required mirror of the credit-op test), a backward-compat pin that a clean extraction hashes identically to an inline-built target literal (pre-extractor proofs still consume), over-cap `root_author` rejection, first-missing-field naming.

Behavioral deltas, both the designed consequences of the parity goal: (a) a whitespace-padded consent-op field now mints/consumes against the trimmed bytes on every mechanism (previously: password path trimmed, ORCID + consume hashed raw → cross-mechanism self-inflicted `target_mismatch`); padded payloads still broadcast raw bytes on-chain, same as the credit-op dismissal — inert under exact-match indexing, do not add a reject-on-untrimmed gate at consume. (b) An over-cap (>64) `root_author` on the ORCID consent issuance or the broadcast consume scan now rejects 400/`malformed` instead of flowing uncapped into Redis state or the raw hash — fail-closed tightening.

**Verification:** `npm run typecheck` (src + tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` unused-directive warning. Targeted suites green: `lib/fresh-auth.test.ts`, `routes/custody-credit-ops.test.ts`, `routes/custody.test.ts`, `routes/orcid.test.ts` — 206 passing, 0 failed (real Redis + Postgres via Docker network IPs). Comment anchors on stable symbols only.

## [TODO Architect]

- `agents/docs/api-contracts/custody.md` + `orcid.md`: if the deferred credit-op 400-surface documentation (from the parent task's archive-time TODOs) is landed, extend it to note the consent-op fields (`root_author` / `root_permlink`) now share the same trim + cap (64 / Hive permlink max) + 400-on-malformed behavior across both issuance mechanisms and the broadcast consume scan. Architect-owned; not edited here.

## Architect re-review (2026-06-10) — HELD PENDING FIXES (1 item)

First review of commit `a6a278f1` via `/ce-code-review` (8-reviewer fleet from architect context: correctness/security/adversarial on the session model; testing/maintainability/project-standards/api-contract/learnings on Sonnet; agent-native skipped per PEvO). **The implementation is verified SOUND — do not redo it:** all three consent-op hash sites converge on the shared extractor; clean-value hashes are byte-identical to the replaced inline literals (the backward-compat pin compares against a genuine hand-built literal); `requireStringField` rejects empty AND whitespace-only fields, so the consume scan is strictly more closed than the removed `readRequiredString`; `StartBodySchema` declares both consent fields, so Zod key-stripping cannot blank the extractor; orphan removal (`readRequiredString`, `ROOT_AUTHOR_MAX_LEN`) is grep-complete; the SPA contract is unaffected (error.code branching only; no SPA consent-op issuance site exists yet); all five applicable `agents/docs/solutions/` learnings comply — this diff is the prescribed consent-op completion of `normalize-before-hash-gate-admits-denormalized-payloads`; the over-cap test pins the independent literal 65 per the dedup-constant convention. One item before archive:

1. **(P2, testing — independently validated) Add route-level coverage for the orcid `/start` consent-branch extraction-failure 400.** The commit changed route behavior (over-cap and whitespace-only `root_author`/`root_permlink` now 400 where the old bare typeof/length checks passed them), and `orcid.test.ts`'s only `/start` `mode=fresh_auth` validation describe block covers credit ops exclusively — the consent branch's failure arm has zero route-level coverage (its happy path is exercised only as a side-effect of the `startAuthed` helper). Add a consent-op describe block mirroring the credit-ops one: missing `root_author` → 400 `VALIDATION_ERROR`; missing `root_permlink` → 400; over-cap (65-char) `root_author` → 400. The 400 validation cases need no Redis and run unconditionally.

### Recorded at triage (no implementer action)

- **Delta (c) — completing the behavior-change record** (adversarial conf-100, corroborated by correctness + security): beyond the implementation note's deltas (a)/(b), whitespace-only consent-op fields flipped from accepted-and-raw-hashed to 400-rejected at the ORCID issuance and the broadcast consume scan (the removed `readRequiredString` checked only `length > 0`; the old ORCID check only `length === 0`), and a field-value-malformed consent payload at consume now fails 400 BEFORE the proof is consumed instead of burning the single-use proof on a 403 `target_mismatch`. Strictly fail-closed in every direction; the api-contract docs landed with the parent task's archive already describe the new surface.
- **Demoted, no action sought:** the `CONSENT_OP_ACCOUNT_MAX_LEN` docblock omits the pre-limiter-export rationale its credit twin carries (conf-50 advisory; optional to fold in while in the file); the padded≡clean and backward-compat pins cover `author_accept` only (both actions share the single extractor branch — low risk).
- **Deploy-window residual, accepted:** a consent-op proof minted pre-deploy via the old ORCID path against padded/over-cap raw values fails closed post-deploy (TTL-bounded 5 minutes, self-healing).
- The `[TODO Architect]` doc note above is DONE — landed with the parent task's archive commit (custody.md + orcid.md consent-op trim/cap/400 notes).

When item 1 lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commit only. Do not edit this hold block — the commit diff is the evidence.

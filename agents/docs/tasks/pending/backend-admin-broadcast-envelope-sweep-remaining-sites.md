# BACKEND-ADMIN-BROADCAST-ENVELOPE-SWEEP-REMAINING-SITES — migrate the remaining inline admin custom_json envelope sites to broadcastAdminCustomJson

**Owner:** Backend Agent
**Created:** 2026-06-09 (architect decision on `backend-admin-broadcast-helper-extraction`: accept the 3/5 adoption, finish the dedup)
**Priority:** P3 (maintainability dedup; no defect — all sites are correct inline today)

## Background

`broadcastAdminCustomJson` (`backend/src/hive.ts`) centralizes the admin custom_json envelope (`id: appTag`, `required_auths: []`, `required_posting_auths: [config.hiveAdminAccount]`, `json`) + `PrivateKey.fromString(config.pevoAdminPostingKey)` + the `AdminKeyNotConfiguredError` guard. It was adopted at 3 sites (`wot.ts` `broadcastWotAccreditation` + `cascadeRevocation`, `routes/claims.ts` admin revoke). The architect accepted that 3/5 and asked for the remaining sites to be swept (decision recorded on the parent task, 2026-06-09).

A review-time grep (`required_posting_auths` + `config.hiveAdminAccount` + `PrivateKey.fromString(config.pevoAdminPostingKey)`) confirmed the complete set of remaining inline sites:

- `routes/papers.ts` (retraction broadcast) — straightforward.
- `routes/accreditation.ts` — straightforward.
- `routes/signup-verify.ts` (`broadcastAccreditationAndSeed`'s admin broadcast) — straightforward, BUT preserve its existing `if (config.pevoAdminPostingKey)` skip-guard (it silently skips the broadcast when the key is unset; do not turn that skip into a thrown `AdminKeyNotConfiguredError`).
- `routes/orcid.ts` ×2 (`handleAccredit`, `handleLink`) — REQUIRES CARE, see below.

## The orcid constraint (do NOT migrate naively)

Both orcid sites keep `PrivateKey.fromString(config.pevoAdminPostingKey)` **OUTSIDE** the inner `try`, so a key-construction throw escapes synchronously to the `withOrcidBindingLock` wrapper → **504 ambiguous-outcome + lock release**. The `SEC-002-TOCTOU-LOCK` describe block pins exactly this shape (verified at the helper-extraction review). Folding the async helper in parses the key INSIDE the `try`, converting that synchronous throw into an inner-catch rejection → **502 BROADCAST_FAILED on the lock-acquired branch** — a security-tested failure-shape change.

To migrate orcid safely: validate/parse the admin key OUTSIDE the inner `try` before the helper call (or re-map `AdminKeyNotConfiguredError` / key-parse errors back onto the wrapper-escape path), AND update the matching `SEC-002-TOCTOU-LOCK` specs deliberately. If this proves heavier than the three straightforward sites, **split orcid into its own task** and land `papers` / `accreditation` / `signup-verify` first.

## Acceptance

1. Each migrated site calls `broadcastAdminCustomJson`; the envelope literal exists only in `hive.ts`. No `required_posting_auths: [config.hiveAdminAccount]` inline construction remains except any deliberately-exempt orcid path (documented if so).
2. Each site's response-on-failure shape is preserved. For orcid specifically, the 504+lock-release boundary holds: `SEC-002-TOCTOU-LOCK` specs stay green, or are updated as a conscious, reviewed change.
3. `signup-verify`'s `config.pevoAdminPostingKey` skip-guard semantics are preserved (no new throw on the unset-key path).
4. **`AdminKeyNotConfiguredError` becomes live with this work.** For each migrated site, confirm it either pre-guards the key (skip path, like wot/claims/signup-verify) or maps the helper's throw to a correct response. Update the `broadcastAdminCustomJson` docblock to reflect that the throw is now reachable from any non-pre-guarded adopter (the docblock was reworded under the parent task to describe the pre-sweep, all-callers-pre-guard state — see `backend-admin-broadcast-helper-extraction`).
5. Comment anchors clean (stable symbols only; no slug/line/SHA/§). `npm run typecheck` + `npm run lint` clean; affected suites green (incl. the orcid `SEC-002-TOCTOU-LOCK` suite).

## References

- `backend/src/hive.ts` — `broadcastAdminCustomJson`, `AdminKeyNotConfiguredError`.
- Inline sites: `routes/papers.ts` (retraction), `routes/accreditation.ts`, `routes/signup-verify.ts` (`broadcastAccreditationAndSeed`), `routes/orcid.ts` (`handleAccredit` + `handleLink`).
- Grep to confirm the residual set before/after: `grep -rn "PrivateKey.fromString(config.pevoAdminPostingKey)" backend/src` and `grep -rn "required_posting_auths.*hiveAdminAccount" backend/src` (`hafsql.ts` hits are HAF validity-rule doc comments, not broadcast sites — exclude).
- Parent: `backend-admin-broadcast-helper-extraction` (the 3/5 extraction this finishes).
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` (grep both directions to confirm the migration is exhaustive).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

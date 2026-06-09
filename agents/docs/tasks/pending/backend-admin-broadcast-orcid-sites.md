# BACKEND-ADMIN-BROADCAST-ORCID-SITES — migrate the two orcid admin custom_json sites to broadcastAdminCustomJson (TOCTOU-lock-careful)

**Owner:** backend
**Created:** 2026-06-09 (split from `backend-admin-broadcast-envelope-sweep-remaining-sites` per that task's explicit "split orcid into its own task" provision; the three straightforward sites — papers / accreditation / signup-verify — landed there)
**Priority:** P3 (maintainability dedup; no defect — the sites are correct inline today)

## Background

`broadcastAdminCustomJson` (`backend/src/hive.ts`) centralizes the admin custom_json envelope (`id: appTag`, `required_auths: []`, `required_posting_auths: [config.hiveAdminAccount]`, `json`) + `PrivateKey.fromString(config.pevoAdminPostingKey)` + the `AdminKeyNotConfiguredError` guard. The parent sweep migrated `papers.ts` (retraction), `accreditation.ts`, and `signup-verify.ts`. The two orcid sites were split here because they need care (the SEC-002-TOCTOU-LOCK failure shape) that the three straightforward sites did not.

Residual inline sites (confirm with `grep -rn "PrivateKey.fromString(config.pevoAdminPostingKey)" backend/src` and `grep -rn "required_posting_auths.*hiveAdminAccount" backend/src`; `hafsql.ts` hits are HAF validity-rule doc comments, not broadcast sites — exclude):

- `routes/orcid.ts` `handleAccredit` (admin attestation broadcast).
- `routes/orcid.ts` `handleLink` (admin attestation broadcast).

## The orcid constraint (do NOT migrate naively)

Both orcid sites keep `PrivateKey.fromString(config.pevoAdminPostingKey)` **OUTSIDE** the inner `try`, so a key-construction throw escapes synchronously to the `withOrcidBindingLock` wrapper → **504 ambiguous-outcome + lock release**. The `SEC-002-TOCTOU-LOCK` describe block (`tests/routes/orcid.test.ts`) pins exactly this shape. Folding the async helper in parses the key INSIDE the inner `try`, converting that synchronous throw into an inner-catch rejection → **502 BROADCAST_FAILED on the lock-acquired branch** — a security-tested failure-shape change.

To migrate safely:
- Validate/parse the admin key OUTSIDE the inner `try` before the `broadcastAdminCustomJson` call (so a key-parse / unset-key fault still escapes synchronously to the wrapper → 504 + lock release), OR re-map `AdminKeyNotConfiguredError` / key-parse errors back onto the wrapper-escape path.
- Update the matching `SEC-002-TOCTOU-LOCK` specs deliberately if the shape changes, as a conscious, reviewed change.

## Acceptance

1. Each orcid site calls `broadcastAdminCustomJson`; no `required_posting_auths: [config.hiveAdminAccount]` inline construction remains in `orcid.ts`. After this lands, the envelope literal exists ONLY in `hive.ts` (the parent sweep removed it everywhere else).
2. The 504+lock-release boundary holds: `SEC-002-TOCTOU-LOCK` specs stay green, OR are updated as a conscious, reviewed change with the new shape documented.
3. `AdminKeyNotConfiguredError` handling is correct for each site: either the key is pre-validated outside the inner try (preserving the synchronous-escape → 504 shape) or the helper's throw is mapped to the intended response.
4. Comment anchors clean (stable symbols only; no slug/line/SHA/§). `npm run typecheck` + `npm run lint` clean; the orcid suite (incl. `SEC-002-TOCTOU-LOCK`) green. NOTE: `orcid.test.ts` mocks `../../src/hive.js`; its factory must provide `broadcastAdminCustomJson` (route it through the suite's existing broadcast mock, mirroring the parent sweep's mock-factory additions in `retract` / `accreditation` / `signup-verify` suites).

## References

- `backend/src/hive.ts` — `broadcastAdminCustomJson`, `AdminKeyNotConfiguredError`.
- `backend/src/routes/orcid.ts` — `handleAccredit`, `handleLink` (the two inline sites); `withOrcidBindingLock` (the wrapper whose 504+lock-release shape the key-parse placement protects).
- `backend/tests/routes/orcid.test.ts` — `SEC-002-TOCTOU-LOCK` describe block.
- Parent: `backend-admin-broadcast-envelope-sweep-remaining-sites` (the three straightforward sites + helper docblock; archived/in-review).
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` (grep both directions to confirm the migration is exhaustive).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

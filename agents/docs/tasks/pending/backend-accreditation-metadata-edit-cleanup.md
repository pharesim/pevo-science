# Accreditation Metadata-Edit Cleanup (perf + maintainability)

**Owner:** backend
**Created:** 2026-06-15

Non-blocking cleanups split out of the editable-accreditation-metadata review (2026-06-15) so they stay off that task's critical fix pass. None of these change behavior. Do them AFTER the held editable-metadata fixes land — they touch the same handler.

## Items

- [ ] **Anchor CTE per-account predicate.** `firstAccreditedAnchorCteBody` (`hafsql.ts`) has no account filter, so the single-account STATUS read (`fetchAccreditationStatusFromHaf` in `routes/accreditations.ts`) and the profile read (`getAccreditationFromHaf` in `routes/profile.ts`) aggregate `MIN(block_num)` over EVERY accredit op before the outer `WHERE account = $username` narrows. It is BitmapAnd-safe and ~0 cost at the current single-digit-row namespace, but it is a latent O(all-accredit-ops) on a hot read path. Add an optional account-filter parameter to the builder (or a single-account variant) so the STATUS and profile call sites scan one account; the LIST route legitimately needs all accounts and stays as-is. Preserve the no-`block_num`-floor / BitmapAnd-avoidance property (do not add a `block_num >= genesis` floor to the custom_json scan).

- [ ] **Extract a reusable `requireFreshAuth` middleware.** The inline JWT fresh-auth gate in the PATCH `/metadata` handler duplicates the same block in `routes/ipfs.ts`. Add `requireFreshAuth(targetFn)` to `lib/fresh-auth.ts` returning an Express middleware (mirroring `requireFreshAdminAuth`), and replace both inline copies. The reason-to-status mapping (`username_mismatch` / `target_mismatch` / `kind_mismatch` -> 403, else 401) is security-relevant and should live in ONE place so it cannot drift between consumers. This also removes the redundant `(req.body as { fresh_auth_proof?: unknown })` cast in the PATCH handler.

- [ ] **Split `routes/accreditation.ts`.** The file is ~1450 lines. Extract the metadata-edit handler (and its per-account limiter) into its own module / sub-router mounted at the same express prefix; it shares none of the OTP / verify / token-cleanup machinery that fills the rest of the file.

## Notes
- Sequence after the held editable-metadata fixes. If the `requireFreshAuth` extraction lands first, the held items 1-3 should be implemented on top of the extracted middleware rather than the inline block.

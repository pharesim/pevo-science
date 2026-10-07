# Accreditation docs drift found while grounding the credential-binding design

**Owner:** architect
**Created:** 2026-10-06
**Priority:** low

Found while grounding `architect-accreditation-mailbox-binding-design`. Triage: user, "as
recommended". Each item is a statement a document makes that the code contradicts; fix by deleting
or narrowing the claim (root `CLAUDE.md` "Comment anchors", last rule).

1. `hive-schemas.md` § 2.3 and `CONCEPTS.md` "Anonymous-review proxy account": the reviewer mapping
   is described as "encrypted in the backend database" with the decryption key "permanently
   deleted" after expiry. The code keeps the ciphertext in Redis (`${appTag}:anon_mapping:` keys,
   180-day TTL, `allkeys-lru` eviction) under one global env key that is never deleted, and no
   code path decrypts. Root `CLAUDE.md` principle 5 ("encrypted, time-limited") and its
   `custom_json` list ("anonymous review mappings") overstate the same thing: the chain holds only
   an attestation hash.
2. `api-contracts/accreditation.md`: `/verify` success is described as "confirmed on chain";
   `broadcastAdminCustomJson` uses `condenser_api.broadcast_transaction`, which returns once a node
   accepts the transaction into its pending pool, as `custody.md` already says for
   `/custody/broadcast`. Same for the handler comment "The chain op landed by this point" (backend
   zone: hand to the comment pass).
3. `api-contracts/orcid.md`: omits `ACCREDITATION_SANCTIONED` and `PENDING_UNVERIFIED` which mode
   `accredit` returns; says `accounts.orcid` is updated "if light account" (any row matched by
   username with `verify_token` NULL); cites a task file that does not exist and line-number
   anchors.
4. `api-contracts/settings.md`: says the add-flow branch is "Reachable only from the Keychain path
   (no JWT is minted before a row exists)" while `POST /api/auth/session` mints one and an
   explicit 401 blocks it; omits state G, the re-issue branch and the `PENDING_UNVERIFIED` 409 on
   set-password.
5. `api-contracts/auth.md`: lists `ACCREDITATION_NOT_FOUND` for `POST /api/auth/signup` (the
   handler answers 422 `VALIDATION_ERROR`); the `/confirm` and `/link` error lists omit the 403
   `ACCREDITATION_SANCTIONED` the cascade returns.
6. `CONCEPTS.md` "No-row Case" says "there is no platform-side session" while § 6.2 says `POST
   /api/auth/session` mints a `'self'` JWT for any Keychain-signed caller; "Self-custody Account"
   omits state G and the `/link`-finalized D row; "Custody Mode" says custody "becomes server-held
   at finalization", false for `/link` and G.
7. `README.md` § Backups: the cron recipe dials `localhost:5432`, which the base compose file does
   not publish (only the test override does), and the restore example names
   `pevo_app_YYYYMMDD.sql.gz` while the script writes `pevo_app_YYYYMMDD_HHMMSS.sql.gz`.
8. `hive-schemas.md` § 2.1 and `ARCHITECTURE.md` § 2: the `manual` note and the per-path
   `evidence_hash` note were corrected on 2026-10-06; re-check both against the code once
   `backend-signup-finalize-evidence-hash-salted` lands.
9. `.env.example`: `APP_DATABASE_URL` "only needed for email notification preferences" (the
   database holds accounts, encrypted custody keys, recovery staging and the bridge queue);
   `UNSUBSCRIBE_SECRET` is read by `config.ts` but absent from the template.

**Progress (2026-10-07).** The archive of the state G unverified-row lifecycle task applied part
of items 3 and 4 (commit `8d27a8f3`):
- Item 3, `orcid.md`: `PENDING_UNVERIFIED` is listed for `/start` and the callback, and step 4 of
  `accredit` and `link` now describes the `verify_token IS NULL` write. Still open:
  `ACCREDITATION_SANCTIONED`, the citation of a task file that does not exist, and the
  line-number anchors.
- Item 4, `settings.md`: done (the add-flow 401, state G in the factor lists, the re-issue
  branch, and `PENDING_UNVERIFIED` on set-password).

Done when each item is fixed or recorded here as dismissed with a reason, and the file is archived.

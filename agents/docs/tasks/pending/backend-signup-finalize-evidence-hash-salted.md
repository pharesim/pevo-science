# The signup finalize publishes an unkeyed hash of the address on chain

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Found while grounding `architect-accreditation-mailbox-binding-design`. Triage: user, "as
recommended".

## Why

`broadcastAccreditationAndSeed` in `backend/src/routes/signup-verify.ts` writes
`evidence_hash = sha256(account.email + ':' + username + ':' + ('signup' | 'link'))`. The formula
is public and has no secret or random input, so anyone reading the chain can confirm which address
accredited a given account by hashing candidates from a staff directory. The email `/verify` path
salts its hash with the one-time token for exactly this reason (`ARCHITECTURE.md` § 2
"Accreditation (custom_json)"). ENISA's guidance on e-mail pseudonymisation treats an unkeyed hash
of an address as reversible.

## Scope

1. Salt the finalize hash with a random per-op nonce that is not stored, as `/verify` does with its
   token: `sha256(email:username:nonce)` for the email path, and the ORCID formula for ORCID-path
   signups (`backend-signup-finalize-claims-mailbox-binding` sets that split).
2. Nothing reads the finalize hash back except the one-time backfill script
   (`backend-mailbox-binding-backfill-script`), which matches the OLD form on ops that already
   exist; existing ops are not rewritten. Land this after the backfill has been run on the
   deployment, and say so in the signal block.
3. `hive-schemas.md` § 2.1 and `ARCHITECTURE.md` § 2 describe the per-path formulas; the architect
   updates them at archive.

## Acceptance criteria

1. Two finalizes for the same address and username produce different `evidence_hash` values.
2. The backfill script's matcher is untouched and its test still matches a pre-change op.
3. Real HAF in tests; comments follow root `CLAUDE.md` "Comment anchors".

## Sequencing

After `backend-mailbox-binding-backfill-script` has been run by the operator.

## [TODO Architect] at archive

- `ARCHITECTURE.md` § 2 "Accreditation (custom_json)" and "Credential Bindings" (Known limits),
  `hive-schemas.md` § 2.1: the signup finalize hash is salted from this change on.

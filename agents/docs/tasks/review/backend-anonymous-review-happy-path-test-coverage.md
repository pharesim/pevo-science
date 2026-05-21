# BACKEND-ANONYMOUS-REVIEW-HAPPY-PATH-TEST-COVERAGE — Add valid-submission round-trip tests

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-8-testing-reviewer.md`)
**Priority:** P0 (testing-tier — no production code defect, but a regression in mapping encryption or proxy broadcast wiring would not be caught)

## Context

`backend/tests/routes/anonymousReview.test.ts` contains rejection paths only: self-review block, co-author check, malformed input, missing fields, etc. No test ever submits a valid anonymous review end-to-end. As a result:

- Mapping encryption (`custody-crypto` AES-GCM with HKDF-derived per-account keys) is not exercised in this test file.
- Proxy-account broadcast wiring (`anonymousReview.ts` → Hive `comment` via proxy account, plus `custom_json` mapping record) is not exercised.
- TTL on the encrypted mapping is not exercised (180 days per audit chunk 1).
- Ciphertext-vs-plaintext byte inequality is not asserted, so a regression that accidentally stored cleartext mappings would silently pass.

This is the only test path for anonymous-review submission. The route can regress silently.

## Goal

Add happy-path coverage:

1. **Valid submission test.** A signed `POST /api/anonymous-review` with a real paper, real reviewer, valid signature passes through the route, produces a Hive comment via the proxy account, and writes a mapping record.
2. **Round-trip seal/persist/fetch/unseal test.** Take the mapping created by the valid submission, fetch it back from Postgres / Redis, and unseal it. Assert the plaintext matches the original reviewer username.
3. **Ciphertext byte-inequality test.** Read the raw stored mapping row, assert the stored bytes do not contain the reviewer's username as a substring (defense against accidental cleartext regression).
4. **Post-TTL expiry test.** Use a short TTL in test config (or override the configured TTL via dependency injection if available) and assert the mapping becomes unreadable after expiry.

These tests use real HAF + Hive + Postgres + Redis per the project test convention. The proxy-account broadcast must actually fire against the test Hive node; if that's impractical, document why under the clause-a/b/c carve-out and add the mock target explicitly.

## Non-goals

- Adding TTL configurability as a feature. Use existing config; if TTL is hardcoded, add a small seam.
- Changing the mapping encryption scheme. The tests validate what exists.

## Acceptance

- `anonymousReview.test.ts` contains at least one valid-submission happy-path test that exercises mapping encryption, proxy broadcast, and DB/Redis persistence end-to-end.
- A separate test (same file or sibling) asserts ciphertext bytes do not equal plaintext bytes for the reviewer username.
- Tests pass against the real test infrastructure.

## References

- Audit chunk: `.context/audit-2026-04-21/chunk-8-testing-reviewer.md` (P0: anonymous review has zero happy-path coverage).
- Related: `backend-custody-crypto-direct-test-coverage.md`.

## Backend implementer signal (2026-05-21)

Added three happy-path / round-trip specs to
`backend/tests/routes/anonymousReview.test.ts` under a new
`POST /api/reviews/anonymous — happy-path mapping round-trip` describe:

1. **Valid-submission round-trip.** POSTs a signed request with a
   third-party reviewer (`carol`) against a staged paper, asserts 200 +
   response envelope shape (proxy account, permlink containing the paper
   slug, tx_id), asserts the comment broadcast fired with
   `parent_author`/`parent_permlink`/`author=hiveAnonAccount` and
   `is_anonymous: true` in `json_metadata`, asserts the attestation
   `custom_json` fired with `id=appTag` + `required_posting_auths=[anon]`
   + `action='anon_review'`, then fetches the mapping via the route's
   exported `getAnonMapping` and asserts `decryptMapping(...)` recovers
   the original reviewer username byte-for-byte.

2. **Ciphertext byte-inequality.** Submits a second review with a longer
   reviewer name (`davidlongername`), reads the raw Redis envelope at
   `${appTag}:anon_mapping:${permlink}` (with in-memory fallback when
   Redis is unavailable), asserts the `encrypted` hex string and all
   common byte decodings of the cipher buffer (utf8 / latin1 / base64 /
   hex-of-utf8) do NOT contain the reviewer username substring. Catches
   a regression that accidentally stored cleartext under the mapping key.

3. **Post-TTL expiry.** Uses the new `__test_seams` export on
   `backend/src/routes/anonymousReview.ts` (exposing the internal
   `storeAnonMapping`/`encryptMapping` and the `ANON_TTL_DAYS` constant
   as a `as const` test-only surface) to seal a mapping with a 1-second
   `expiresAt`, asserts it is readable immediately, sleeps 2500ms, then
   asserts `getAnonMapping` returns null. Exercises both the Redis
   `EX 1` eviction path and the in-memory fallback's
   `new Date() > expiresAt` predicate.

Mocks added under the file-header carve-out: stubbed
`broadcastSendOperationsWithTimeout` + `broadcastJsonWithTimeout` so the
test does not need a funded `pevo.anon`/proxy account on pevotest, and a
config override that pins `pevoAnonPostingKey` to a deterministic
seed-derived WIF and `anonReviewEncryptionKey` to a SHA-256 of a test
seed (the project `.env` leaves both empty). Real-path companion
documented in the header (`verifyHiveSignature-authmethod.test.ts` for
the auth gate; the AES-GCM seal itself runs unmocked against `node:crypto`
and real Redis here, so the encrypt/persist/unseal chain is the real
risk-class coverage).

Production seam: only the `__test_seams` constant block was added at the
bottom of `backend/src/routes/anonymousReview.ts`. The route handler does
not reference it; no behavioural change. The handler still hardcodes
`ANON_TTL_DAYS = 180` and uses `storeAnonMapping` directly. Lint clean
(only pre-existing unrelated warning in `lib/author-supersession.ts`),
typecheck clean, 11/11 targeted specs green.

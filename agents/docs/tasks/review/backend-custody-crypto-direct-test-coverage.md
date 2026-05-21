# BACKEND-CUSTODY-CRYPTO-DIRECT-TEST-COVERAGE — Add unit tests for AES-256-GCM + HKDF custody crypto

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-8-testing-reviewer.md`)
**Priority:** P0 (testing-tier — no production code defect today, but the module has zero direct tests; any silent regression in IV handling, HKDF context, or cipher choice would ship)

## Context

`backend/src/custody-crypto.ts` implements AES-256-GCM symmetric encryption of light-account posting + memo keys, with per-account encryption keys derived via HKDF from the master `CUSTODY_ENCRYPTION_KEY` env var plus the username as HKDF info/context.

The module is referenced in tests only as a fixture helper (`recover.test.ts` and `signup-verify-stuck-recovery.test.ts` import `encryptKey` to mint test ciphertexts; `vi.mock(...)` bypasses it elsewhere). Nothing asserts:

- AES-GCM round-trip (encrypt → decrypt yields original).
- Tamper detection (single bit flip in ciphertext or tag triggers decrypt error).
- Username context separation (ciphertext for `alice` does not decrypt under HKDF info `bob`).
- IV non-reuse (two encryptions of the same plaintext produce different ciphertexts).
- GCM (not CBC) — accidental cipher downgrade catch.
- Master key length validation (audit P2: current check accepts 16-byte keys; spec is 32).

The module is load-bearing for every light-account broadcast and recovery path. A silent regression in HKDF context (drop username, accept attacker's ORCID-derived ciphertext under Alice's account) is undetectable through current tests.

## Goal

Add `backend/tests/lib/custody-crypto.test.ts` covering:

1. **Round-trip.** Encrypt a known plaintext under a known username; decrypt; assert equality.
2. **Tamper detection.** Flip one bit in ciphertext / tag / nonce / aad; assert decrypt throws.
3. **Context separation.** Encrypt under username A; attempt decrypt under username B; assert throws.
4. **IV non-reuse.** Encrypt the same plaintext twice; assert ciphertext bytes differ.
5. **Master key length.** Construct module with a 16-byte master; assert it refuses (or document why 16-byte is currently accepted with a P2 follow-up).
6. **GCM tag presence.** Assert the ciphertext envelope includes a non-empty auth tag (defense against silent CBC swap).

## Non-goals

- Property-based fuzzing across all CryptoJS variants. Targeted tests are enough.
- Rotating master keys / re-encryption flows. Separate concern.

## Acceptance

- `backend/tests/lib/custody-crypto.test.ts` exists with the six properties above.
- Tests use the real `crypto` module — no mocks of `crypto.createCipheriv` etc.
- A deliberate breaking mutation (e.g., drop username from HKDF info) causes at least one test to fail.

## References

- Audit chunk: `.context/audit-2026-04-21/chunk-8-testing-reviewer.md` (P0: custody-crypto.ts has no direct tests).
- Module: `backend/src/custody-crypto.ts`.

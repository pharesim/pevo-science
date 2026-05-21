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

---

## Architect re-review (2026-05-21, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` on commit `c8981377` (8 reviewers — correctness, security, adversarial on opus; testing, maintainability, project-standards, kieran-typescript, learnings-researcher on sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All six acceptance properties pinned with the idiomatic vitest `vi.resetModules()` + env-mutation + dynamic-import pattern; canonical `crypto.hkdfSync` independent decryption (the last spec in the file) provides the strongest no-mock mutation-kill against HKDF-info-drop. Module-load ordering verified through `vitest.config.ts` → `tests/setup.ts` → `process.env` mutation → `vi.resetModules()` → dynamic import. Sibling-precedent confirmed in `backend/tests/lib/pending-decrement-queue.test.ts` (same dynamic-import idiom).

Four items held — two P1 anchor-hygiene rot, two P2 structural-coupling between test and production.

### Items held (must fix before archive)

**1. (P1, conf 100 cross-reviewer 3×: maintainability M2 + project-standards PS-001 + kieran-typescript KT-2) The "audit P2 follow-up notes the spec is 32 BYTES (64 hex chars)" comment inside the "accepts a 32-hex-character master key" spec embeds coordination context (severity-label + triage-artifact reference) in test source.** Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`: coordination context belongs in commit messages and task files, not in production or test source. The behavioral content is self-contained without the prefix.

  Fix: strip "The audit P2 follow-up notes" and adjacent qualifiers, leaving the self-contained behavioral sentence — e.g., "The spec calls for 32 bytes (64 hex chars), but the current validator boundary is 32 hex characters. Pin the current boundary so any tightening of the validator is a deliberate, test-visible change." Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, verify the replacement text introduces no new rot class (line numbers, slugs, SHAs).

**2. (P1, conf 90, maintainability M1) The file-header docblock quotes a task prescription verbatim** (`"which the task forbids (\"Tests use the real \`crypto\` module — no mocks of \`crypto.createCipheriv\` etc.\")"`). The quoted clause becomes a dead pointer when the task archives.

  Fix: replace with behavioral rationale, e.g., "`crypto.createCipheriv`, `crypto.hkdfSync`, and `crypto.randomBytes` are exactly the primitives under test — mocking them would reduce coverage to tautology." Or any equivalent that anchors on the behavioral reason rather than citing the task's prescription. Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the replacement must use stable behavioral anchors (no task slug, no round number, no line-number reference).

**3. (P2, conf 80, maintainability M3) HKDF info prefix `'pevo:custody:'` is hardcoded in the canonical-derivation test (`pevo:custody:alice` literal in the `crypto.hkdfSync` invocation) independently of `backend/src/custody-crypto.ts`'s inline `pevo:custody:${username}` template literal.** A production-side prefix change would cause loud test failure (canonical key diverges → GCM auth-tag mismatch → decipher throws), so the silent-coupling framing in the original finding is partially mitigated. The structural concern remains: test and production carry duplicate string constants of the same value with no cross-reference. A future reader changing the prefix would need to touch two files; the test's mutation-kill power against a prefix change would not detect a coordinated dual-edit.

  Fix: export `HKDF_INFO_PREFIX` (or equivalent name; implementer's call between `HKDF_INFO_PREFIX`, `CUSTODY_HKDF_INFO_PREFIX`, etc.) from `backend/src/custody-crypto.ts`. Use the export in both the production `deriveKey`'s template literal and the test's canonical-derivation block. Single source of truth.

**4. (P2, conf 75, maintainability M4) `AUTH_TAG_LENGTH = 16` is re-declared inside one `it()` body in the test; bare `16` appears in two further tag-slice assertions.** Production declares `const AUTH_TAG_LENGTH = 16` and `const IV_LENGTH = 12` but exports neither. Three independent copies of the AES-GCM tag-length constant in the test, one in production, no cross-reference.

  Fix: export `AUTH_TAG_LENGTH` and `IV_LENGTH` from `backend/src/custody-crypto.ts` and replace the local re-declaration and the two bare `16` literals in the test with the imports. Cipher-mode changes (a swap to a different AEAD with a different tag length) would touch one constant rather than scattered copies.

### Items dismissed during architect triage

- **(P2, conf 75, security)** `SAMPLE_WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3'` is structurally a valid Hive mainnet WIF with no documented provenance. User-triaged dismissal at architect session: accept as test-only fixture; residual risk that it's a real authority key is accepted.
- **(testing T1)** `afterEach` does not call `vi.resetModules()` — fragile convention if future dynamic-import tests are added without their own leading reset. Theoretical-only failure mode; current file is structurally safe (no later tests use dynamic import). Dismissed per `feedback_dismiss_preemptive_test_hardening`.
- **(kieran-typescript KT-1)** `afterEach` comment says "re-import" but only restores env var. Clarity nit, sub-confidence-gate.
- **(adversarial)** No golden-vector test pins on-disk ciphertext format; no spec for empty-username derivation. Both preemptive coverage of mutation classes the canonical-derivation test already kills (prefix change, KDF swap), or behavioral edge cases the codebase does not exercise today. Dismissed per `feedback_dismiss_preemptive_test_hardening`.
- Below-anchor and lower-confidence findings suppressed by the anchor-75 gate per skill default.

**Pre-existing residual (not in this commit's diff):** Security reviewer noted `backend/src/custody-crypto.ts`'s `deriveKey` validator accepts 16-byte master keys (32 hex characters) while `.env.example` documents 32-byte (64 hex). HKDF makes this non-exploitable today (any IKM length ≥ output length is structurally fine; the derived 32-byte per-account key remains full AES-256 strength). The test deliberately pins the current acceptance boundary at 32 hex chars so a future validator tightening to 64 hex chars becomes test-visible. Audit P2 follow-up — out of scope for this review.

### Re-review signal

When items 1–4 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Items 1–2 are one-line comment edits in two different sites in the same test file. Items 3–4 are paired production-export-plus-test-import changes touching `backend/src/custody-crypto.ts` plus the test file. Implementer's call between bundling everything in a single focused commit or splitting into "comment cleanup" + "export constants from production" commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

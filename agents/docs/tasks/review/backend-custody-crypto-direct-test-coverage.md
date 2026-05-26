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

---

## Backend re-review signal (2026-05-21, commit 5fa9a43d)

All four hold items landed in commit `5fa9a43d` (single focused commit per the implementer-call option in the architect's re-review-signal note above).

- **Item 1 (anchor hygiene, 32-hex spec comment).** In `backend/tests/lib/custody-crypto.test.ts`, the spec titled "accepts a 32-hex-character master key" lost the "The audit P2 follow-up notes the spec is 32 BYTES..." prefix. The replacement reads "The spec calls for 32 bytes (64 hex chars), but the current validator boundary is 32 hex characters. Pin the current boundary so any tightening of the validator is a deliberate, test-visible change." No task slug, no severity label, no round marker, no SHA, no line-number reference.

- **Item 2 (anchor hygiene, file-header docblock).** The "which the task forbids (\"Tests use the real ...\")" quoted clause is gone. The replacement reads: "`crypto.createCipheriv`, `crypto.hkdfSync`, and `crypto.randomBytes` are exactly the primitives under test, so mocking them would reduce coverage to tautology." Stable symbol anchors only.

- **Item 3 (HKDF info prefix shared constant).** `HKDF_INFO_PREFIX = 'pevo:custody:'` is now `export`ed from `backend/src/custody-crypto.ts`. Production `deriveKey` builds the HKDF info string with `` `${HKDF_INFO_PREFIX}${username}` ``; the test's canonical-derivation block imports `HKDF_INFO_PREFIX` from the same module and builds `` `${HKDF_INFO_PREFIX}alice` ``. Single source of truth.

- **Item 4 (AUTH_TAG_LENGTH and IV_LENGTH exports).** `AUTH_TAG_LENGTH` and `IV_LENGTH` are now `export`ed from `backend/src/custody-crypto.ts`. The test imports both, drops the local `const AUTH_TAG_LENGTH = 16` re-declaration, and replaces the two bare `16` literals in the tag-slice assertions (auth-tag length expectation, trailing tag-slice subarray bounds in the canonical-derivation test) with `AUTH_TAG_LENGTH`. The bare `12` in the IV-length assertion is replaced with `IV_LENGTH` for the same reason.

Verification:
- `npm run typecheck` from `backend/` passes.
- `npm run lint` from `backend/` clean (only the pre-existing `author-supersession.ts` unused-eslint-disable warning, unrelated to this task).
- `npx vitest run tests/lib/custody-crypto.test.ts` from `backend/`: 18 tests pass.

---

## Architect re-review (2026-05-26) — HELD PENDING FIXES (round 3)

Re-review intake note on the orphan SHA: the round-2 signal above cites commit `5fa9a43d`, which is NOT an ancestor of HEAD (it was committed in a worktree and never merged). The round-2 content landed identically at `b9dff52b` in HEAD — patch bodies compared byte-for-byte, no work lost. The orphan is benign; flagging for the worktree-fanout-orphan-detection record. `/ce-code-review` for this re-review scoped to `b9dff52b` (8 reviewers — correctness/security/adversarial on Opus; testing/maintainability/project-standards/kieran-typescript/learnings on Sonnet; ce-agent-native-reviewer skipped per PEvO). Five reviewers clean; the round-2 constant-dedup (round-1 hold items 3 + 4, which this re-review prescribed) is confirmed byte-for-byte safe and behavior-preserving. Two items held — both are coverage REGRESSIONS introduced by the dedup itself, cross-corroborated by adversarial + testing + learnings (anchor 100). These are NOT preemptive hardening: round-2 removed independent literal pins the test previously carried.

### Items held (must fix before archive — bundle into one round-3 commit)

**1. (P2, conf 100, cross-reviewer: adversarial + testing + learnings) Sharing `HKDF_INFO_PREFIX` between test and production made a prefix-VALUE change invisible to the canonical-derivation test.** Before round-2 the canonical-derivation block hardcoded `'pevo:custody:alice'` independently; a production prefix change would have flipped the test RED. Now both production `deriveKey` and the test re-derivation read the same exported `HKDF_INFO_PREFIX`, so a prefix change updates both sides together and the test passes green. The failure mode is catastrophic and currently unguarded: changing the prefix makes every already-stored custody ciphertext (light-account posting + memo keys) permanently undecryptable on the recovery/broadcast paths. The mutation classes the comment explicitly claims to kill (username-drop, KDF-swap) remain killed; only the prefix-value case regressed.

Fix: add a standalone value-pin assertion — `expect(HKDF_INFO_PREFIX).toBe('pevo:custody:')` — in the canonical-derivation describe block (or a dedicated `it`). This restores the independent pin without re-introducing the literal duplication the round-2 dedup removed (the dedup's value was de-duping the derivation INPUT; a single explicit value-pin is the canonical single point). Mutation-kill: any change to `HKDF_INFO_PREFIX`'s value flips this assertion RED. Anchor on the stable `HKDF_INFO_PREFIX` symbol — no slug/round/line/SHA.

**2. (P2, conf 100, cross-reviewer: adversarial + testing) Sharing `IV_LENGTH` / `AUTH_TAG_LENGTH` made the length assertions tautological for a constant-VALUE drift.** Same mechanism: the IV-length and auth-tag-length assertions now compare module output against the same module-exported constant, so an `IV_LENGTH` `12→16` or `AUTH_TAG_LENGTH` `16→12` drift passes silently. Both would break stored-ciphertext interoperability. Before round-2 these were bare literals (`toBe(12)`, `+ 16`) that pinned the value independently.

Fix: add value-pin assertions alongside the constant-based ones — `expect(IV_LENGTH).toBe(12)` and `expect(AUTH_TAG_LENGTH).toBe(16)` — in the IV-non-reuse / GCM-tag describe blocks. Keeps the constant-sourced assertions (which catch a divergence between `randomBytes(IV_LENGTH)` and the declared constant) AND restores the value pin. Anchor on the stable symbols.

### Re-review signal

When items 1–2 land in a single round-3 commit, `git mv` this file back to `tasks/review/`. The mv is the re-review signal. Round-3 architect re-review scopes `/ce-code-review` to the round-3 commit only. Both items are one-line `expect(...).toBe(...)` additions in the existing test file; no production change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-26)

Both round-3 items landed in `backend/tests/lib/custody-crypto.test.ts` (test-only, no production change), restoring the independent value pins the round-2 constant-dedup had made tautological:

- **Item 1 (HKDF prefix value pin).** A dedicated `it('pins the HKDF info prefix value …')` in the canonical-derivation describe block asserts `expect(HKDF_INFO_PREFIX).toBe('pevo:custody:')`. A change to the exported prefix value now flips this RED independently of the shared-constant derivation (which would otherwise update both sides together and pass green while every stored custody ciphertext became undecryptable).
- **Item 2 (IV / tag length value pins).** `expect(IV_LENGTH).toBe(12)` added in the IV-non-reuse block alongside the existing `expect(iv.length).toBe(IV_LENGTH)`; `expect(AUTH_TAG_LENGTH).toBe(16)` added in the GCM-tag block alongside the existing constant-sourced length assertion. The constant-sourced assertions stay (they catch divergence between `randomBytes(IV_LENGTH)` and the declared constant); the value pins catch a constant-VALUE drift that would break stored-ciphertext interoperability.

Each addition carries a comment anchored on behavioral semantics (stored-ciphertext interoperability, forgery resistance) — no slug, round number, line number, or SHA.

Verification: `npm run typecheck` clean (src + tests); `npm run lint` clean on the test file; targeted `npx vitest run tests/lib/custody-crypto.test.ts` green.

Moves the task back to review/.

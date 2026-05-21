---
title: "Coverage-claim downgrade requires codebase search, not verbatim negation"
date: 2026-05-21
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Responding to an architect hold-block that asks for a downgrade of an overstated coverage claim in a test-file header or docstring"
  - "Editing a test-file header that cites a clause-(b) or clause-(c) real-path companion test"
  - "Writing a clause-(c) section asserting that a risk class has no real-path companion in the domain"
  - "Performing a convention-enforcing fix that rewrites a test-file header in response to a code-review finding"
related_components:
  - code-review
  - documentation
tags:
  - hold-block
  - coverage-claim
  - carve-out
  - test-headers
  - factual-verification
  - clause-c
  - code-review
  - downgrade-trap
---

# Coverage-claim downgrade requires codebase search, not verbatim negation

## Context

Test-file headers that cite a clause-(c) real-path companion test exist to satisfy the CLAUDE.md "Running Tests" carve-out: when a mocked-pool test bypasses `verifyHiveSignature` (or any other always-real surface), it must name where real-path coverage is exercised for the same risk class, or acknowledge the gap narrowly. When an architect hold-block flags an over-claim (the named companion turns out to also mock the same surface), the implementer must downgrade the claim.

The failure mode that prompts this convention is a symmetric one. The over-claim sends future readers to a test file that does not actually provide the coverage it promises. The "fix" path — negating the original claim verbatim — is seductive because it looks like it directly addresses the finding: the claim said "coverage exists," so say "coverage does not exist." But this swap is only safe if coverage genuinely does not exist. If coverage lives somewhere less obvious (a different test module, a file named for a different domain), the negation produces a factual under-claim that is just as misleading as the original, and the "fix" now actively hides the working signpost from future readers.

The downgrade path selects for skipping verification because the implementer's instruction was narrow: downgrade the claim. A search step is not explicitly in that instruction, and verifying an absence is harder work than negating a sentence. The convention must make the search step explicit and mandatory, not implied.

## Guidance

When asked by an architect hold-block to downgrade an overstated coverage claim in a test-file header, follow this four-step procedure before writing any replacement text.

**Step 1 — Identify the risk class the original claim addressed.**

Read the clause-(b) and clause-(c) sections of the header. The risk class is the failure mode the original claim was written to cover, not the file's primary focus. Example: if the file's focus is SQL-shape predicates and the clause-(b) acknowledgment mentions `verifyHiveSignature`, the risk class is cryptographic-verification bypass (a caller sending a malformed or replayed signature reaching a protected route).

**Step 2 — Search the codebase for any real-path test exercising that risk class.**

Do not restrict the search to the same test module or domain directory. Coverage often lives in:

- `backend/tests/routes/auth.test.ts` — which exercises real `verifyHiveSignature` against multiple routes, including routes from other domains, as part of proving cross-endpoint-replay rejection and malformed-signature rejection.
- `*-canary.test.ts` files that pin integration-level invariants.
- Any test file whose header explicitly says it does NOT hoist `MOCK_VERIFY_SIGNATURE`.

Search for the route path (e.g., `/api/notifications`) and for the risk-class symbol (e.g., `verifyHiveSignature`) across the full `backend/tests/` tree. A single grep of the route path is the minimum viable search; a grep for the risk-class symbol scoped to the test tree is a useful complement.

**Step 3 — Choose the accurate replacement.**

After the search, two outcomes are possible:

- **A real-path companion exists**: cite it by file name and describe what it covers (which failure modes it exercises against the route). Anchor on stable file path and route path, not line numbers.
- **No real-path companion exists**: scope the absence narrowly. State which failure modes are uncovered (e.g., "no test exercises a valid-signature success path that proceeds to HAF") rather than that no coverage exists in the domain. A broad "no real-path test exists" claim can be just as wrong as the original over-claim if the domain is large.

**Step 4 — Audit the replacement for coordination-state phrasing.**

Per the CLAUDE.md comment-anchor convention, do not include "no separate task filed yet," "follow-up pending," or similar coordination-state phrases in test source. If a gap needs tracking, file a task or omit the promise. The replacement text should read as a permanent statement about coverage, not a moment-in-time coordination note.

## Why This Matters

Both the over-claim and the under-claim mislead future maintainers. The over-claim sends them to a test that does not provide the coverage it promises. The under-claim sends them away from a test that does. The asymmetry in harm is that the under-claim is produced by someone who was told to fix a bug — it arrives with the authority of a deliberate correction and is less likely to be questioned at the next review.

In the notifications domain the concrete sequence was: `backend/tests/routes/notifications-arm-sql-shape.test.ts` originally claimed that `notifications.test.ts` was the real-`verifyHiveSignature` companion. That claim was false — `notifications.test.ts` hoists `MOCK_VERIFY_SIGNATURE` throughout. The architect's hold-block correctly identified the false claim and offered two resolutions: downgrade the claim, or add the companion. The implementer chose the downgrade and wrote: "No real-`verifyHiveSignature` integration test currently exists in the notifications domain."

That replacement claim is also false. `backend/tests/routes/auth.test.ts` does not hoist `MOCK_VERIFY_SIGNATURE`. It stubs only `hiveClient.database.getAccounts` to return a deterministic test public key, so real cryptographic verification via `verifyHiveSignature` runs end-to-end. That file exercises `/api/notifications` against real `verifyHiveSignature` middleware in multiple places: cross-endpoint-replay rejection (a signature bound to `/api/auth/session` must not authenticate `/api/notifications`) and malformed-signature rejection. These are exactly the rejection-path tests that constitute clause-(c) coverage for the cryptographic-verification risk class.

The under-claim did not just fail to mention `auth.test.ts`. It actively told future readers there was nothing to look at — in a file whose purpose is to document where to look for real-path coverage. A maintainer following the under-claim would conclude a real-path companion needed to be written, would write it, and would create duplication or a conflicting fixture setup. The working signpost was removed from the one place readers were expected to consult it.

The downgrade direction is the lower-effort path for the implementer (no test work, just edit a header), which is precisely why it selects for skipping the codebase grep that would catch the under-claim. The convention's job is to make that grep step explicit so the labor cost doesn't silently push implementers toward the verbatim-negation shortcut.

## When to Apply

- Receiving an architect hold-block that asks to downgrade an overstated coverage claim in a test-file header (clause-(b) or clause-(c) section).
- Editing a test-file header that names a specific test file as a real-path companion — verify the named file actually provides the claimed coverage before leaving the claim in place.
- Writing a clause-(c) section that says a risk class has no real-path companion — search first; the companion may exist under a different domain name.
- Performing a convention-enforcing fix that rewrites a test-file header — the replacement text is itself subject to the same factual-accuracy requirement as the original.

The convention also applies to `/ce-compound` or `/ce-compound-refresh` passes that touch coverage-claim language in `agents/docs/solutions/` entries: any prose that asserts a risk class is uncovered is a factual claim, and factual claims require codebase verification.

## Examples

**The route in question:** `GET /api/notifications`.
**The risk class:** cryptographic-verification bypass (a caller presenting a malformed, expired, or cross-endpoint-replayed Hive signature must be rejected by real `verifyHiveSignature` middleware, not only by the mocked fixture).

**Round-1 over-claim (what triggered the hold-block):**

```
 *   (b) `verifyHiveSignature` is mocked via the project-wide
 *       MOCK_VERIFY_SIGNATURE fixture. This file's focus is SQL-shape
 *       predicates, NOT cryptographic verification behavior, so the
 *       carve-out's clause-(b) refinement permits the fixture.
 *       The real `verifyHiveSignature` middleware is exercised against
 *       signed requests in `notifications.test.ts` (the clause-(c)
 *       real-path companion).
```

False: `notifications.test.ts` hoists `MOCK_VERIFY_SIGNATURE` and every signed request in it uses the literal `'mock-sig'` header. No real cryptographic verification runs there.

**Round-2 under-claim (what the implementer produced after the hold-block):**

```
 *   (b) `verifyHiveSignature` is mocked via the project-wide
 *       MOCK_VERIFY_SIGNATURE fixture. This file's focus is SQL-shape
 *       predicates, NOT cryptographic verification behavior, so the
 *       carve-out's clause-(b) refinement permits the fixture: the
 *       401-on-missing-header gate and the username-extraction behavior
 *       are preserved; only the cryptographic signature check is bypassed.
 *       No real-`verifyHiveSignature` integration test currently exists
 *       in the notifications domain — `notifications.test.ts` also hoists
 *       `MOCK_VERIFY_SIGNATURE` and its signed requests use the literal
 *       `'mock-sig'` header. The SQL-shape focus alone satisfies the
 *       clause-(b) refinement here; a real-signature companion for
 *       `/api/notifications` is a follow-up (no separate task filed yet)
 *       and not required for the gates this file pins.
```

Also false, and in the opposite direction: `backend/tests/routes/auth.test.ts` does not hoist `MOCK_VERIFY_SIGNATURE`. It stubs only `hiveClient.database.getAccounts` so real cryptographic verification via `verifyHiveSignature` runs end-to-end. It exercises `/api/notifications` against real `verifyHiveSignature` middleware, including explicit cross-endpoint-replay rejection and malformed-signature rejection — exactly the rejection-path tests for the cryptographic-verification risk class. The under-claim removed the only working signpost from future readers' field of view, and the "no separate task filed yet" parenthetical violates the comment-anchor convention.

**Corrected wording (what should have been written after searching):**

```
 *   (b) `verifyHiveSignature` is mocked via the project-wide
 *       MOCK_VERIFY_SIGNATURE fixture. This file's focus is SQL-shape
 *       predicates, NOT cryptographic verification behavior, so the
 *       carve-out's clause-(b) refinement permits the fixture: the
 *       401-on-missing-header gate and the username-extraction behavior
 *       are preserved; only the cryptographic signature check is bypassed.
 *       The rejection-path risk class (cross-endpoint-replay and
 *       malformed-signature) is covered by real `verifyHiveSignature`
 *       middleware in `backend/tests/routes/auth.test.ts`, which exercises
 *       `/api/notifications` without hoisting MOCK_VERIFY_SIGNATURE
 *       (it stubs only `hiveClient.database.getAccounts` to publish a
 *       deterministic test public key so real cryptographic verification
 *       runs end-to-end). The residual gap is a valid-signature success
 *       path that proceeds through to HAF for the notifications query;
 *       that path is not pinned by this file or by auth.test.ts.
```

This wording: cites the actual companion by stable file path and route path, accurately scopes what the companion covers (rejection paths) versus what remains uncovered (the success-path-to-HAF), and omits coordination-state phrases.

## Related

- `agents/docs/solutions/conventions/comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md` — direction-complementary sibling. That convention covers the expansion direction (don't add inaccurate expanded clauses when growing a comment); this convention covers the downgrade direction (don't replace an over-claim with an unverified negation). Same root cause (no pre-write codebase check), same fix discipline (search before writing), same artifact site (test header). Together they form the complete write-time accuracy rule for test-header prose changes.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — motivating ancestor. Sets up clause-(b) and clause-(c) as the framework in which companion-coverage claims live in test headers. This convention governs how to maintain those claims when an architect hold-block asks for a correction.
- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — adjacent: governs accuracy of a test's own mutation-kill claims against the assertion-plus-corpus triple. Different verification target (the test's own behavior, not the surrounding coverage landscape), but the same underlying discipline of verifying claims against running code.
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — adjacent: when a fix purges convention violations, the fix's own added code must be audited for fresh violations. The downgrade-trap is a specific instance of "the fix introduced a new factual error while correcting the original."
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — supports step 4. Coordination-state phrasing in test source ("no separate task filed yet") rots on task archive even when the underlying claim is correct.

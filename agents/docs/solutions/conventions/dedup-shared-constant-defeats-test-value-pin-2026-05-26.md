---
title: "Deduping a constant shared between test and production silently removes the test's value-pin"
date: 2026-05-26
last_updated: 2026-06-09
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - A dedup or anchor-hygiene fix exports a production constant and routes a test assertion through the imported symbol
  - The assertion's expected value and the production value under test both resolve to the same exported constant
  - The constant is load-bearing for correctness or stored-data compatibility (crypto parameter sizes, derivation prefixes, wire-format version tags)
  - "Deciding whether a derived locator (array index, map key, slot) sourced from a shared symbol needs its own value-pin (it does not, when the expected value is an independent literal)"
tags:
  - test-coverage
  - dedup
  - value-pin
  - constants
  - anchor-hygiene
  - cryptography
  - regression
  - slot-pin
related_components:
  - testing_framework
  - authentication
---

# Deduping a constant shared between test and production silently removes the test's value-pin

## Context

A common maintainability fix removes a "magic number" duplicated between production and a test: export the constant from the production module, import it into the test, and replace the test's hardcoded literal (`expect(iv.length).toBe(12)`) with the imported symbol (`expect(iv.length).toBe(IV_LENGTH)`). This silences the duplicate-literal complaint, but it silently REGRESSES the test's ability to catch a change to that constant's *value*. After the dedup, both the assertion's expected value and the production code under test read the same symbol, so a mutation that changes the constant updates both sides together and the assertion stays green.

This surfaced in `backend/tests/lib/custody-crypto.test.ts` after `backend/src/custody-crypto.ts` exported `IV_LENGTH` (12), `AUTH_TAG_LENGTH` (16), and `HKDF_INFO_PREFIX` (`'pevo:custody:'`) as named constants and the test was routed through them. The test that previously pinned `expect(iv.length).toBe(12)`, and the canonical-derivation test that re-derived with the string literal `'pevo:custody:alice'`, were both updated to read the imported constants. The independent value-pin was lost.

## Guidance

When deduping a constant shared between test and production, keep ONE independent value-pin alongside the constant-sourced assertion:

```ts
// value-pin: an independent literal restatement — catches a change to the constant itself
expect(IV_LENGTH).toBe(12);

// constant-sourced assertion: catches a divergence between two USES of the constant
expect(iv.length).toBe(IV_LENGTH);
```

Both are necessary; they catch different failure modes. The value-pin is not redundant with the constant-sourced assertion — it is the only assertion that fails when the constant's value drifts. A test that asserts `f() === THE_CONSTANT_f_USES` is partly tautological for the constant's value.

Apply this for any constant whose mutation would be a silent breaking change: cryptographic parameter sizes (`IV_LENGTH`, `AUTH_TAG_LENGTH`, key lengths), derivation/serialization prefixes (`HKDF_INFO_PREFIX`), and wire-format version discriminators or tag strings. For constants whose value is not load-bearing for correctness or stored-data compatibility (a log prefix, a UI string, a cache TTL), DRY wins cleanly and no value-pin is needed.

### Carve-out: a derived LOCATOR is not the tautology when the expected VALUE is a literal

The tautology above requires the assertion's *expected value* to be sourced from the same shared symbol as the production value under test. Deriving only the *locator* — the array index, slot position, map key, or column name used to *read* the value under test — from a shared symbol is a different shape, and it is sound as long as the expected value stays an independent literal:

```ts
// Locator derived from the same builder the handler composes — tracks structural growth.
const USERNAME_SLOT = buildWith(1, sharedCteBuilder, otherCteBuilder).params.length;
// Expected value is an independent literal — a real value-pin, not a tautology.
expect(params[USERNAME_SLOT]).toBe('unaccredited-spammer');
```

A positional mis-bind puts a *different* value at the derived locator, so `expect(read(derivedLocator)).toBe(LITERAL)` fails red on a wrong binding, and the locator tracks legitimate growth of the shared structure automatically — the desired behavior, not a coverage hole. Do NOT add a redundant literal locator-pin (`expect(USERNAME_SLOT).toBe(7)`): the only failure mode it guards is "a future structural change re-stales the locator," and that scenario still turns the value assertion red, so the extra pin is preemptive hardening, not restored coverage — default-dismiss it per the project's dismiss-preemptive-test-hardening posture. (Contrast with the section above: when a value-pin was genuinely lost to a dedup, restoring it IS restored coverage, not preemptive hardening.)

The discriminating question is unchanged: "if the production value is mis-bound, does any assertion fail?" A value-pinned derived-locator canary answers yes. Only when the *expected value itself* resolves through the shared symbol does the assertion go vacuous and need an independent literal restatement.

## Why This Matters

The `HKDF_INFO_PREFIX` case makes the stakes concrete. The prefix is the HKDF `info` argument in key derivation — the info string is `HKDF_INFO_PREFIX` concatenated with the username. Every light-account posting key and memo key encrypted at rest was derived with this prefix. If someone changes `HKDF_INFO_PREFIX` (e.g. to `'pevo:custody:v2:'` during a key-rotation feature), the canonical-derivation test re-derives with the same imported constant and GCM-decrypts successfully — the test stays green — while every already-stored ciphertext becomes permanently undecryptable on the recovery and broadcast paths. The literal `'pevo:custody:'` in a value-pin is the only assertion that would catch this.

`IV_LENGTH` is lower severity, same shape: after the dedup, `expect(iv.length).toBe(IV_LENGTH)` only confirms the code used the constant consistently — it says nothing about whether `IV_LENGTH` is still 12. A GCM IV must be 12 bytes for standard interoperability; a drift to 16 would not fail any test, it would silently break interoperability with stored ciphertexts.

This is a coverage regression introduced by a specific fix, not speculative hardening. It is the COMPLEMENT of the preemptive-hardening dismissal default: that default dismisses test-quality findings whose failure modes are purely theoretical and never existed in the code. Here the value-pin existed and passed before the dedup; the dedup removed it. Do not dismiss restoring it as preemptive — it is restoring coverage a refactor took away.

## When to Apply

At review and at implementation time, whenever a refactor or hygiene fix replaces a test's expected-value literal with an import of the constant that literal described, ask: "If someone changes this constant's value, does any assertion fail?" If the answer is no, add a value-pin. The question is the durable check; the export is the trigger to ask it. When only the *locator* (array index, map key, column name) is derived from a shared symbol and the expected value is an independent literal, no extra pin is needed — the value assertion already fails red on a positional mis-bind, and a literal locator-pin would be preemptive hardening.

## Examples

**Before dedup — independent literal (full value coverage, but duplicates the number):**

```ts
const { iv } = encryptKey('alice', plaintext);
expect(iv.length).toBe(12); // literal, independent of production
```

**After dedup — constant-sourced only (value-pin lost):**

```ts
import { IV_LENGTH } from '../../src/custody-crypto.js';

const { iv } = encryptKey('alice', plaintext);
expect(iv.length).toBe(IV_LENGTH); // no longer catches IV_LENGTH changing from 12
```

**Correct — constant-sourced assertion PLUS a restored value-pin:**

```ts
import { IV_LENGTH, AUTH_TAG_LENGTH, HKDF_INFO_PREFIX } from '../../src/custody-crypto.js';

// value-pins: fail before any production data is affected if a constant drifts
expect(IV_LENGTH).toBe(12);
expect(AUTH_TAG_LENGTH).toBe(16);
expect(HKDF_INFO_PREFIX).toBe('pevo:custody:');

// constant-sourced assertions: catch divergence between uses of the constant
const { iv, ciphertext } = encryptKey('alice', plaintext);
expect(iv.length).toBe(IV_LENGTH);

// canonical-derivation test re-derives independently — but uses the SAME symbol,
// so it cannot catch a prefix-value change; the value-pin above is what does.
const canonical = crypto.hkdfSync('sha256', masterKey, '', `${HKDF_INFO_PREFIX}alice`, 32);
```

A positive example of doing this right without an exported constant: `backend/tests/seed-phrase.test.ts` pins key derivation against `PrivateKey.fromLogin(...).toString()` directly rather than against a constant re-exported from `seed-phrase.ts`, so the test's expected value is genuinely independent of the code under test.

**Derived locator from a shared symbol (sound — expected value is a literal):**

A route handler binds SQL params as `[...sharedCteBuilder.params, username, appTag, anonAccount, ...]`, and a param-position canary pins that `username` lands at the right position.

```ts
// Wrong (frozen slot + typeof): silently passed once the CTE param count grew
// and slot 3 moved onto a different string param.
expect(typeof params[3]).toBe('string');

// Wrong in a different way (the tautology this doc opens with): the expected
// value is ALSO sourced from the shared symbol, so both sides move together.
expect(params[USERNAME_SLOT]).toBe(EXPECTED_USERNAME_FROM_PRODUCTION);

// Correct: derived locator, independent literal expected value.
const USERNAME_SLOT = buildWith(1, sharedCteBuilder, otherCteBuilder).params.length;
expect(params[USERNAME_SLOT]).toBe('unaccredited-spammer'); // fails red on a positional mis-bind
```

Empirical mutation-kill: swapping the `username` and `appTag` binds put the appTag value at `USERNAME_SLOT` and the literal value-pin failed red. The slot number itself was never asserted; the production binding was what mattered, and the literal caught it.

## Related

- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the root principle this specializes: every spec must fail when the code it covers is mutated. The shared-constant tautology is one specific way a spec structurally cannot fail.
- `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — sibling assertion-honesty concern (a kill claim wrong because the mechanism is misunderstood or the corpus is idempotent). Together these close the assertion-honesty space.
- `test-seams-export-shape-as-const-2026-05-04.md` — shares the production-export-into-tests theme but the inverse direction of harm (it guards test mutations corrupting a seam; this guards production mutations no longer being observable through the assertion).
- `structural-mirror-test-silent-staleness-on-wrapper-adoption-2026-05-20.md` — the contrasting shape: a test pins a value that diverges from production after a change. Here production and test share a constant so they CANNOT diverge, which is exactly why a value drift goes unobserved.
- `exact-pin-cross-half-crypto-lib-2026-05-16.md` — same custody/HKDF/seed-phrase domain; context for anyone working the key-derivation area.
- `evalscript-test-mocks-both-verbs-and-key-discriminator-2026-05-26.md` — a live instance of the locator carve-out: the mock routes on `args[2] === counterKey` (a shared production key used as the LOCATOR to pick the intercepted call) while the expected outcome stays independent, so it is sound, not tautological.

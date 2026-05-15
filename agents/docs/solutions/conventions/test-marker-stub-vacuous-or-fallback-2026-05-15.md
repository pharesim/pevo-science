---
title: Marker-stub trap — OR-fallback tests that cannot fail
date: 2026-05-15
category: conventions
module: frontend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Writing a test that guards a `value || fallback` expression where the test owns `value` via a stub, mock, or fixture"
  - "The stub returns a non-falsy marker (sentinel prefix, identity-of-key, fixed string) intended to signal whether the fallback fired"
  - "The assertion checks output matches the marker form rather than asserting the fallback's content is absent"
  - "Reviewing a test that claims to protect an OR-fallback regression class"
tags:
  - testing
  - stub-design
  - or-fallback
  - vacuous-pass
  - mutation-soundness
  - i18n
---

# Marker-stub trap — OR-fallback tests that cannot fail

## Context

When writing a test to guard against a future regression to `value || fallback` where the test stubs `value`, a natural instinct is to make the stub return an identifiable marker so the assertion can "tell whether the fallback fired" — e.g., change `$t = (key) => key` to `$t = (key) => 't:' + key`, then assert `.toMatch(/^t:/)`. The reasoning sounds correct: "if the fallback fires, `err.message` takes over and the output won't start with `'t:'`." But the reasoning is structurally wrong. Under the marker stub, `value` is always a non-empty string and therefore truthy, so the OR-fallback never short-circuits — regardless of whether the production code is the safe form or the regressed form. The assertion cannot distinguish them. It is vacuous.

This trap surfaced in PEvO during the round-3 architect re-review of `FE-UPGRADE-CREDENTIAL-WIPE` (commits `9af76fd` introduced the vacuous form, `c65bc87` removed it). The matcher passed both whether the production code wrote `upgradeError = $t('upgrade.failed')` or whether it had been mutated to `upgradeError = $t('upgrade.failed') || err.message`. The test claimed to guard a credential-leak regression and could not catch it.

## Guidance

**The trap:** stub `value` to a truthy marker in order to detect whether `fallback` was used. Truthy `value` means the OR never reaches `fallback`. The test is structurally incapable of catching the regression it describes.

```js
// TRAP — sentinel-prefixed stub, vacuous OR-fallback guard
comp.$t = (key) => 't:' + key;  // always truthy

// Safe production:    upgradeError = $t('upgrade.failed')              → 't:upgrade.failed'
// Regressed:          upgradeError = $t('upgrade.failed') || err.msg   → 't:upgrade.failed' (short-circuits)
// Both produce the same string. The matcher cannot tell them apart.
expect(comp.upgradeError).toMatch(/^t:/);  // passes in BOTH cases
```

**The fix:** for the specific call site under test, stub `value` to FALSY so the OR-fallback actually executes. Inject realistic leak content into `fallback` so the `not.toContain` assertions have something to detect.

```js
// FIX — falsy stub at the specific call site, realistic leak content
const leakHex = 'deadbeef' + 'c'.repeat(56);
const leakSeedWords = 'apple banana cherry donkey eagle frog giraffe hill ink jellyfish kiwi lemon';
vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error(`derive failed: hex=${leakHex} seed="${leakSeedWords}"`);
}));

const comp = createComponent();
// Override $t to return '' (falsy) for the single key under guard.
// Other keys still resolve normally so unrelated assertions in the flow are unaffected.
comp.$t = (key) => (key === 'upgrade.failed' ? '' : key);

await comp.executeUpgrade();

// Under safe code  (upgradeError = $t(...)):           upgradeError = ''   → assertions pass vacuously on empty string.
// Under regressed (upgradeError = $t(...) || err.msg): upgradeError = err.message containing leakHex → FAILS.
expect(comp.upgradeError).not.toContain(leakHex);
expect(comp.upgradeError).not.toContain(leakSeedWords);
```

Scope the falsy override to the single key (or value) under guard. Don't make `$t` return `''` for everything — that affects sibling assertions in the same flow and breaks tests that depend on other keys resolving normally.

**Sibling test note.** A separate test running under the identity stub `(key) => key` is still useful and not redundant: it catches *direct bypass* (`upgradeError = err.message` with no `$t` call), where the regressed string `err.message` doesn't equal `'upgrade.failed'` so the equality assertion fails. The two tests cover distinct mutation classes (direct bypass vs OR-fallback short-circuit) and both are needed.

## Why This Matters

The marker-stub trap doesn't just fail to catch OR-fallback regressions — it actively *replaces* the narrower direct-bypass coverage that the identity stub would have provided, with an assertion that looks broader but is empty. A reader sees `.toMatch(/^t:/)` paired with a comment about OR-fallback regression and believes the class is guarded. It isn't. The sentinel prefix changes the stub's semantics in a way that defeats the very mutation it was introduced to catch.

When `fallback` carries sensitive data — key material, PII, internal state, raw error bodies — a vacuous guard is a false-safety claim. The production code can be mutated to the regressed form and the suite stays green. The credential-leak surface this trap appeared on was exactly that risk class: `err.message` could embed BIP39 seed entropy or raw private-key hex if a future dhive revision throws with entropy-shaped text, and the matcher said it was protected when it wasn't.

The mechanism is also resistant to local review. The intent comment ("matches the regression class") and the assertion ("matches the marker prefix") feel internally consistent. Catching it requires walking the truthy/falsy flow of the OR explicitly, which is not what a reviewer naturally does when an assertion's shape already looks like a regression-class guard.

## When to Apply

- Any test asserting that a `value || fallback` expression does NOT use the fallback.
- Any test where the OR's left operand comes from a stub, mock, or fixture you own.
- Specifically: i18n key guards (`$t(key) || raw`), config-with-default patterns (`config.x || DEFAULT`), cache-miss paths (`cache.get(k) || lookup()`), header-or-generate patterns (`req.headers[h] || generate()`), env-with-fallback (`process.env.X || 'dev'`).
- Any time a code reviewer sees "stub returns sentinel prefix" paired with "assert output starts with sentinel" — check whether the stub is always truthy.

## Examples

### Primary — i18n key leak guard (the originating case)

```js
// BEFORE (trap) — sentinel-prefixed stub
comp.$t = (key) => 't:' + key;
// ...inject key-material-shaped throw...
await comp.executeUpgrade();
expect(comp.upgradeError).toBe('t:upgrade.failed');  // direct-bypass guard, fine
expect(comp.upgradeError).toMatch(/^t:/);            // vacuous — stub never falsy, OR never fires

// AFTER (fix) — falsy override at the single guarded key
comp.$t = (key) => (key === 'upgrade.failed' ? '' : key);
// ...inject the same key-material-shaped throw...
await comp.executeUpgrade();
expect(comp.upgradeError).not.toContain(leakHex);    // fails iff OR-fallback regression lands
```

### Generalization to other OR-fallback shapes

```js
// Config default — TRAP
vi.spyOn(config, 'timeout', 'get').mockReturnValue(999);   // truthy
const t = resolveTimeout();                                // = config.timeout || DEFAULT
expect(t).toBe(999);  // passes whether or not the OR fallback executed

// Config default — FIX
vi.spyOn(config, 'timeout', 'get').mockReturnValue(undefined);  // falsy
const t = resolveTimeout();
expect(t).toBe(DEFAULT_TIMEOUT);  // fails if code returns config.timeout only, no fallback
```

```js
// Cache miss — TRAP
mockCache.get.mockReturnValue('cached');  // truthy, lookup never called
const v = readWithFallback();             // = cache.get(k) || expensiveLookup()
expect(mockExpensiveLookup).not.toHaveBeenCalled();  // passes regardless of OR

// Cache miss — FIX
mockCache.get.mockReturnValue(null);      // falsy, fallback fires
const v = readWithFallback();
expect(mockExpensiveLookup).toHaveBeenCalled();
```

```js
// Header-or-generate — TRAP
const req = { headers: { 'x-trace-id': 'fixed-trace-id' } };   // truthy
const id = resolveTraceId(req);                                // = req.headers['x-trace-id'] || generate()
expect(id).toBe('fixed-trace-id');  // says nothing about whether generate() would fire

// Header-or-generate — FIX
const req = { headers: {} };                                   // missing → undefined (falsy)
const id = resolveTraceId(req);
expect(generateMock).toHaveBeenCalled();
```

The shape is the same in every case: the test must force the OR's left operand to falsy at the specific call site under test, so the fallback path actually executes and the assertion has something to differentiate.

## Related

- [tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md](tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md) — the general principle that a test must be structurally capable of failing under the mutation it guards. This entry is a specific named trap shape within that principle (the parent doc enumerates four categories; this is a fifth).
- [frontend-error-sanitization-2026-04-21.md](frontend-error-sanitization-2026-04-21.md) — the canonical sanitization convention this test was guarding. Documents the correct `deadbeef` canary and identity-stub assertion shape but does not explain *why* the `$t` stub being truthy matters for `|| fallback` detection. This entry fills that gap.
- [js-coercion-mutation-kill-vector-2026-05-04.md](js-coercion-mutation-kill-vector-2026-05-04.md) — sibling from the same "test passes for the wrong reason" family. Different mechanism (coercion-hint mismatch vs truthy-stub short-circuit); same meta-shape.
- [mock-guard-assertion-must-verify-call-shape-2026-04-21.md](mock-guard-assertion-must-verify-call-shape-2026-04-21.md) — sibling. Different mechanism (mock predicate guard satisfied by default fallback) but the same failure mode: outer assertion green without the code under test executing.

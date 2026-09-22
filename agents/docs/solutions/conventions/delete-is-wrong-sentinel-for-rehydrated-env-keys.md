---
title: "`delete process.env.KEY` cannot suppress a value an env loader re-hydrates"
date: 2026-09-22
category: conventions
module: frontend/tests/e2e global setup and teardown
problem_type: convention
component: testing_framework
severity: medium
root_cause: test_isolation
resolution_type: test_fix
applies_when:
  - "A test suppresses an env var for code that hydrates `process.env` from a file behind an if-absent-then-set guard"
  - "The suppression is written as `delete process.env.KEY` rather than assigning a present-but-falsy value"
  - "A test's hermeticity rests on a catch-block fallback rather than an assertion that the intended skip branch ran"
  - Writing or reviewing a global setup or teardown helper that loads env vars from several files in sequence
symptoms:
  - "`delete process.env.REDIS_URL` ran before `await globalTeardown()`, yet the test still opened a real Redis socket"
  - The test stayed green, because the failed connect was caught and the assertions never examined Redis
  - A green 1931-test suite was not evidence of hermeticity; four adversarial review lenses found the leak, the suite never did
related_components:
  - frontend
  - development_workflow
tags:
  - env-var-hydration
  - sentinel-pattern
  - test-isolation
  - hermeticity
  - global-teardown
  - vitest
  - guard-inversion
  - false-green
---

# `delete process.env.KEY` cannot suppress a value an env loader re-hydrates

## Context

A vitest unit test covering cleanup ordering in `frontend/tests/e2e/global-teardown.js` needed to stay off the network. It called the real `globalTeardown` export after running `delete process.env.REDIS_URL`, on the assumption that an unset URL would make the Redis half skip.

It did the opposite. `globalTeardown` opens by calling its local `loadEnvFile` helper on `frontend/.env.test` and then on the repo-root `.env`, and that helper's only gate before writing is a presence check, `!(key in process.env)`. Deleting a key is precisely what makes that check pass, so the delete was undone on the next statement and `cleanupIpfsPins` read a live connection string.

The trap arrived by substitution rather than by carelessness. The test used to stay off the network by deleting `IPFS_API_URL`, which hit an early-return guard before any Redis or Kubo work. A change that gave `IPFS_API_URL` and `APP_TAG` host-side defaults in `cleanupIpfsPins` (so the cleanup would actually run, having silently returned at that first guard on every real run until then) removed the early return the test had been leaning on. `delete process.env.REDIS_URL` was reached for as a like-for-like replacement. It is not one: `REDIS_URL` has no default and is read straight off `process.env` after the `loadEnvFile` calls, so "deleted" and "never set" are not the same state by the time it is read.

## Guidance

**Pick the sentinel against the guard's own predicate, not by habit.** Two properties are needed at once: the guard has to consider the key already set, so it skips it, and the consumer has to read it as off. Against a presence guard, `!(key in process.env)`, assigning `process.env.KEY = ''` satisfies both, and that is the fix here. `delete` satisfies only the second, and only until the next load.

The two forms do not generalise to each other. Against a truthiness guard, `!process.env[key]`, an empty string is falsy, so the loader overwrites it and the suppression fails the same way `delete` fails against a presence guard. There the only value that survives hydration is a truthy one, which then has to be a value the consumer independently treats as off. Read the guard before choosing the sentinel.

**Assert the branch the hermeticity depends on.** A sentinel change alone is not durable. Assert the specific observable side effect of the intended path, such as the skip warning string, so that a future edit reintroducing any form the loader can undo fails loudly instead of passing quietly.

**This is not a blanket rule against `delete process.env.X` in tests.** The trap is specific to entry points that re-hydrate `process.env` from a file through a presence-only guard. Exactly two helpers use the presence form: `loadEnvFile` in `frontend/tests/e2e/global-teardown.js` and `hydrateEnvFromFile` in `frontend/tests/e2e/global-setup.js`, whose guard predicates are byte-identical. A third hydration point, the inline `.env` loader in `backend/tests/bench-reputation.ts`, uses the truthiness form instead, which is the concrete reason the sentinel is chosen per guard rather than once and for all. Code that reads `process.env` once, or that parses a file into a separate object without writing back (`parseEnvFile` in `frontend/tests/e2e/fixtures/auth.js` is a pure parser and never mutates `process.env`), is unaffected by either form. The other `delete process.env.X` sites in the frontend unit tests are safe for exactly that reason: they exercise `scanTracesForSecrets` and `getSessionSecret` directly and never route through either hydrating helper.

## Why This Matters

The failure is invisible in the one signal most likely to be trusted. The test passed, on every run, for a reason unrelated to what it asserted: the loopback Redis port is published only under `./deploy.sh test-up`, so in dev mode the re-hydrated URL simply failed to connect, `cleanupIpfsPins` caught it, warned, set its client to `null`, and the assertions, which were about ordering, never looked. The suite reported green and the port being closed was doing the work the test believed its own setup was doing.

That makes the consequence environment-dependent rather than absent. Run the same unit test while the stack is in test mode, when Redis really does answer on loopback, and it reaches a live Redis and deletes `${APP_TAG}:ipfs:pending:<cid>` ledger keys as a side effect of what was supposed to be a network-free ordering assertion. The blast radius is small but the mechanism is silent, which is the combination that survives review.

The generalizable half is about evidence: an assertion over the wrong observable cannot tell the intended path from an unintended one that happens to converge on the same passing outcome. Presence-versus-truthiness is one instance. The habit worth keeping is to check why a test passes, not that it passed.

## When to Apply

- Suppressing an env var for code that loads env from a file. Check the loader's guard before choosing the sentinel: an if-absent-then-set guard makes `delete` self-defeating.
- Adding or removing a default in code a test relies on for isolation. A default that closes an early-return path silently invalidates any test that depended on that path for hermeticity.
- Reviewing a test whose isolation claim lives in a comment rather than an assertion.

## Examples

Before, which the loader undoes on the next statement:

```js
delete process.env.REDIS_URL;
await globalTeardown();
```

After, present so the guard skips it and falsy so the consumer skips:

```js
process.env.REDIS_URL = '';
await globalTeardown();
// ... and assert the branch actually taken:
expect(warnSpy).toHaveBeenCalledWith(
  '[e2e teardown] REDIS_URL not set. skipping redis key deletion.',
);
```

A standalone probe settles it either way without touching a repo file. Replicate the loader's guard, run it against the real `frontend/.env.test`, and print presence and truthiness after each form:

```
delete  (the old form): present=true truthy=true -> would OPEN A SOCKET
= ''    (the fix)      : present=true truthy=false -> skips
```

`present=true` after a delete reads as paradoxical until you notice it is measured after the same load pass the real code runs. The delete is real at the instant it executes; the guard undoes it before the value is ever read.

A cheaper behavioral signal needs no probe. `cleanupIpfsPins` appends its redis-keys-deleted clause to the summary line only when the client is non-null, so a genuinely skipped run prints `1/1 unpinned` with no `, N redis keys deleted` suffix.

## Related

- `agents/docs/solutions/conventions/final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md` is the closest cousin on the prevention rule: an assertion over the wrong observable cannot discriminate the intended path from an unintended one reaching the same state. Different substrate (backend dispatch-versus-confirm timing), same lesson.
- `agents/docs/solutions/test-failures/sync-nexttick-mock-unhandled-rejection-after-test-pass-missing-refs-2026-09-22.md` and `agents/docs/solutions/test-failures/assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17.md` anchor the same false-green family: a test passed for a reason other than the one its intent claims.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` governs the `fetch` spy that sits in the same test file. That spy is a separate, self-justified construct and not the subject of this entry; the two should not be conflated.

## Provenance

The bad sentinel arrived with the change that gave `IPFS_API_URL` and `APP_TAG` their host-side defaults in `cleanupIpfsPins`, and was replaced one commit later by the empty-string form plus the skip assertion. Both are local commits on `main` with no PR to cite, so this entry anchors on the behavioral description rather than a hash, which a rebase or a fresh clone may not carry. `git log` over `frontend/tests/unit/global-teardown.test.js` finds them.

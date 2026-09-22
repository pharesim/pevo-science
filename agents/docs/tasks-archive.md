## UI-EDIT-SPEC-UNHANDLED-MOUNT-REJECTIONS — Three edit-page specs leave `_mountEditors` dereferencing an unset `$refs`, so vitest exits 1 on a green suite (archived 2026-09-22) — 1 round; fix at e579c8c4 (createComponent() defaults `$refs = {}`; redundant local default in loadedComponent() removed); review clean ✓

### Architect archive note (2026-09-22)

Reviewed e579c8c4 via `/ce-code-review` (correctness, project-standards, testing, adversarial in-process, learnings; cross-model not run because the reviewed commit is no longer the working tree). Zero primary findings; AC 1-4 verified independently: spec at e579c8c4 81 passed / 0 errors / exit 0 versus parent 81 / 3 errors / exit 1; teardown-guard block intact; full unit suite in isolated two-level copies exits 0 on both e579c8c4 (86 files / 1918 tests) and the current tree 7a47b52a (86 / 1931, the delta being later sibling ui(tests) commits); only the spec file changed. Alpine 3.15.11's `$refs` magic always returns a `mergeProxies` object, so the `{}` default is a faithful stand-in and masks nothing `undefined` surfaced. Two pre-existing coverage gaps surfaced for separate triage (no test asserts the load path schedules the mount with refs populated; the init-registration test's retry is a no-op via `_loadInFlight`, so the task's own mechanism for test 1 was wrong while its classification was right). The production discarded-promise observation stays out of scope as the task recorded.

**Owner:** ui
**Created:** 2026-09-22

Surfaced while the architect closed the "suite green" claim on
`ui-empty-string-proof-reads-as-ready-window` in an isolated copy. Every test
passes at HEAD (86 files / 1911 tests) and vitest still exits 1:

```
Test Files  86 passed (86)
     Tests  1911 passed (1911)
    Errors  3 errors
```

All three are unhandled rejections that originate in
`frontend/tests/unit/pages-edit.test.js`, and the file reproduces them alone
(81 passed, 3 errors, exit 1). Not introduced by any task currently in flight:
the three tests date from 2026-05-06 (`c0de45bc`, `26c3b6b0`).

## What happens

`createComponent()` in the spec builds the page object from the `Alpine.data`
factory and mocks `$store`, `$t`, `$watch` and `$nextTick` (as a synchronous
call-through), but never sets `$refs`. On a successful `loadPaperData`, the
handler schedules `this._mountEditors()` through `$nextTick` and discards the
promise. `_mountEditors` passes its `_mounted` guard, awaits the dynamic
`editor.js` import, then reads `this.$refs.abstractEditor` on `undefined`:

```
TypeError: Cannot read properties of undefined (reading 'abstractEditor')
 > Object._mountEditors src/pages/edit.js  (the `this.$refs.abstractEditor` read)
```

Nothing awaits that promise, so the TypeError surfaces as an unhandled
rejection after the test has already passed. The three tests that take the
success path with `_mounted = true` and no `$refs`:

1. `init() registers every draft $watch handler + 1 storage listener exactly once; subsequent loadPaperData() does not re-register`
   (the `reactive bindings register exactly once across retries` block). The
   second `loadPaperData()` does not throw again only because the first
   `_mountEditors` had already set `_editorsInitialized` before it threw.
2. `rapid concurrent invocation: only one fetch fires; post-state reflects single consistent result`
   (the `loadPaperData concurrent-retry guard` block).
3. `flag resets after Promise.allSettled rejection so retry can proceed`
   (same block; the second, successful load is the one that mounts).

The `loadPaperData catch:` test in the same region sets `_mounted = true` too
but takes the failure path, so it never schedules the mount.

The spec already knows the shape. The draft-restore block's `loadedComponent()`
helper sets `comp.$refs = {}` with a comment saying exactly why: "an empty
$refs lets that deferred mount find no editor elements instead of
dereferencing undefined." That fix was applied locally to one describe block
and not to the harness the whole file shares.

## Why it is worth closing

A non-zero exit on an all-pass suite is a lie in both directions. Every
implementer's "suite green" claim is currently made by reading the test count
and ignoring the exit code, and the next real unhandled rejection anywhere in
the tree lands in the same bucket where nobody looks. CI, when it exists, will
fail on it.

## What to change

Default `$refs` in the shared harness: `comp.$refs = {}` inside
`createComponent()`. The `_mountEditors teardown-during-init guard` tests set
their own `$refs` (null elements, mock elements, `{}`) after construction and
are unaffected by a default. Once the default exists, `loadedComponent()`'s own
`$refs = {}` line and its comment become redundant; drop them or leave a
one-line pointer, either is fine. Do NOT guard `this.$refs` in `edit.js` for
this: a real Alpine component always has `$refs`, so a production guard would
defend a state only the harness produces.

## Observation, not in scope

The same `$nextTick(() => { this._mountEditors(); })` shape discards the
promise in production too, so a failed chunk import of `editor.js` (a real
outcome on a flaky connection for a code-split module) becomes a browser-level
unhandled rejection rather than reaching `loadError`. Recorded for the user to
triage separately; do not widen this task to it.

## Acceptance criteria

1. `npx vitest run tests/unit/pages-edit.test.js` reports 0 errors and exits
   0, with the three unhandled rejections gone and no test skipped or
   weakened. Driven proof-first: observe the three rejections before the fix.
2. The `_mountEditors teardown-during-init guard` block still passes with its
   own `$refs` assignments intact.
3. The full unit suite exits 0. At HEAD the three edit-spec rejections are the
   only errors, so this follows from criterion 1 unless something else has
   landed since; if it has, say so in the signal block rather than absorbing
   it.
4. No change under `frontend/src/`.

---

## UI implementation signal (2026-09-22, commit e579c8c4)

`e579c8c4` `ui(tests): the edit harness gives every component a $refs`.
Self-verified: `git merge-base --is-ancestor e579c8c4 main` returns 0, and
`git show --name-status` lists exactly one file.

**The change.** 7 insertions / 4 deletions, both hunks in
`frontend/tests/unit/pages-edit.test.js`. `createComponent()` sets
`comp.$refs = {}` after the `$nextTick` mock, with a comment naming why (a real
Alpine component always has `$refs`; the deferred mount is discarded, so an
unset `$refs` becomes a post-pass unhandled rejection; cases needing live or
stale refs assign their own after construction). `loadedComponent()`'s local
`$refs = {}` and its three-line comment are removed as redundant. Nothing under
`frontend/src/`.

**AC 1 (spec clean, driven proof-first).** Observed the failure before touching
anything: `npx vitest run tests/unit/pages-edit.test.js` at HEAD gave
`81 passed (81)` / `Errors 3 errors` / exit 1, all three
`TypeError: Cannot read properties of undefined (reading 'abstractEditor')` at
`_mountEditors`. After: `81 passed (81)`, no Errors line, exit 0. Same 81 tests,
none skipped or weakened.

**AC 2 (teardown-guard block intact).** `npx vitest run
tests/unit/pages-edit.test.js -t 'teardown-during-init'` gives `4 passed | 77
skipped`, exit 0. All four assign their own `$refs` after construction, so the
default is overwritten where the block cares.

**AC 3 (full suite exits 0), and the count discrepancy the AC asks about.**
Full suite in the checkout: `86 passed (86)` / `1918 passed (1918)` / no Errors
/ exit 0. The task records 1911 tests at HEAD; the tree is at 1918. Nothing
landed to explain it: `git log 1affd33c..HEAD -- frontend/` is empty, so no
frontend code has changed since this task was filed. The 1911 was the
architect's isolated copy built from an older base. Proven by building a copy
from HEAD itself (`git archive HEAD frontend backend/src/lib/authMessage.ts`,
both `node_modules` symlinked) and running the full suite there:
`86 passed (86)` / `1918 passed (1918)` / `Errors 3 errors` / exit 1. So
before and after differ in the Errors line and the exit code only, and those
three rejections were indeed the only errors in the whole tree.

**AC 4.** `git show --name-status e579c8c4` lists only the spec file.

### Adversarial audit (4 lenses, 0 survivors)

Ran a four-lens panel with independent refutation, all probes in scratchpad
copies (the shared checkout was never written to or run in). Every finding was
judged; none survived.

- *Weakened assertions.* Instrumented the production `$refs` read itself. Across
  all 81 tests it is reached exactly 11 times, identically in both states. Eight
  reaches already carried a non-undefined `$refs`; only three flip `undefined` →
  `{}`, and they are exactly the three rejections. None of the three asserts on
  `_editorsInitialized`, `_abstractEditor`, `_bodyEditor` or `mockCreateEditor`.
  A per-test `mockCreateEditor` call-count-and-arg-shape dump diffs empty across
  81 tests. `$refs` is a fresh literal per call, every in-spec assignment is a
  wholesale reassignment (zero in-place mutations), and no test asserts `$refs`
  is undefined or snapshots the component's own-property set.
- *Mutation coverage.* Five prescribed mutants plus two unprescribed ones, each
  run against both states, judged on failing-test lines rather than exit code
  (the pre-change baseline already exits 1). Kill matrices are identical
  cell-for-cell. The two survivors (`if (true)` on the element guards; deleting
  the `$nextTick` mount scheduling) survived before the change as well, so
  neither is coverage this diff destroyed.
- *Comment anchors.* No slug, ordinal, `Option X.N`, `AC #N`, line number, SHA
  or positional anchor in the new comment; it anchors on `$refs`,
  `loadPaperData`, `_mountEditors`, `$nextTick`, all of which exist and behave as
  described. `.githooks/tests/test-pre-commit.sh` passes 37/37, and the real
  hook run against a throwaway repo staging this exact diff exits 0
  non-vacuously (all seven added lines reached the scan, no `anchor-allow`
  marker present, and a planted positive control fails the hook). Removing the
  `loadedComponent()` comment orphaned nothing.
- *Sibling sweep (survey only, per the no-widening constraint).* Zero siblings
  to report. Only `edit.js` and `publish.js` read `$refs` off a component
  instance, and `pages-publish.test.js` already sets `$refs` in its own
  `createComponent()`. Widening to the structural shape, the six other specs
  that mock `$nextTick` run `248 passed`, no Errors, exit 0.

### Note for the user, not filed as a task

One finding surfaced and was refuted as pre-existing and out of scope: the
spec's file-header block calls the file a "Minimal test harness ... focused on
the error-message-sanitization catch-block behavior", which understates a file
that now also covers mount teardown, uploads, fresh-auth gating and the
addressed-review ticks. It is byte-identical at HEAD, is not an anchor-rot
class, and this diff does not make it more false. Left alone; worth folding
into an unrelated sweep if one comes along.

The observation the task recorded as out of scope still stands unaddressed: the
same `$nextTick(() => { this._mountEditors(); })` discards its promise in
production, so a failed chunk import of `editor.js` becomes a browser-level
unhandled rejection rather than reaching `loadError`. The mutation pass
confirmed nothing asserts that scheduling at all. For the user to triage.


## UI-EMPTY-STRING-PROOF-READS-AS-READY-WINDOW — An empty-string proof passes every fresh-auth narrowing and arrives as a ready window (archived 2026-09-22) — 2 rounds; production fix at 33e10833 + 3b75bab9 (mint callback narrowed to `typeof proof === 'string' && proof`, three new cases pin it); round-2 hold item (clause-(a) header reason) fixed at 5c563f14; re-review clean ✓

### Architect archive note (2026-09-22, round 2)

Re-reviewed 5c563f14 via `/ce-code-review` (correctness, project-standards, testing, learnings; adversarial and cross-model not selected for a comment-only diff). Zero findings. The clause-(a) header now names `file.arrayBuffer()` as the blocker; both citations (`crypto.test.js`, `harness.test.js`) resolve and are accurate; no anchor-rot shape introduced. The implementer's correction of the hold's premise is confirmed by three independent reviewer probes: jsdom 25.0.1's `Crypto-impl.js` implements only `getRandomValues`/`randomUUID`, the `crypto` global under vitest's jsdom environment is Node's webcrypto, so "jsdom provides it" was a wrong attribution. The hold's conclusion (crypto.subtle is not the blocker) stands. Hold item 1 FIXED.

Dispositions of the signal block's "For the architect" notes:
1. `agents/docs/solutions/conventions/carve-out-clause-a-impracticability-claims-are-unverified-prose-2026-09-22.md` carries the same wrong "jsdom provides it" attribution and labels the unit instance "prescribed, pending" although it has now landed. Routed to `/ce-compound-refresh` scoped to that entry (not hand-edited). The entry's e2e ORCID and posting-key-decrypt instances remain open under `ui-non-consent-spec-header-overclaims`.
2. The vitest exit-1 on `pages-edit.test.js` is closed by e579c8c4, which landed after the hold commit c1e4d844; its own task `ui-edit-spec-unhandled-mount-rejections` sits in review/ for a separate pass. Confirmed.

Informational residuals, no task filed: the header drops `crypto.test.js`'s "in this version" hedge, which is accurate for the pinned `jsdom ^25.0.1` and goes stale only on a major bump; no assertion pins `Blob.prototype.arrayBuffer === undefined` under jsdom, the expected default per the canaries-only-for-untestable-code stance. Compound: no new entry; the learning already exists as the clause-(a) entry and its correction is a refresh.

# An empty-string proof passes every fresh-auth narrowing and arrives as a ready window

**Owner:** ui
**Created:** 2026-09-16

Surfaced by the round-4 review of `ui-fresh-auth-shared-dispatch-and-retry-gate`
while measuring what each falsy value does downstream. Not a defect that round
introduced: it is the empty-string sibling of the null-proof coercion that
round 3 landed, and it has been open since the window was built. Recorded in
that task's re-review signal and filed here on the user's triage, because
closing it is a code change and that round was prose-only.

## What happens

A mint response carrying `"fresh_auth_proof": ""` reaches the consumers as a
live window. Every narrowing in the path tests the TYPE, and `''` is a string.

1. The mint callback in `acquireSessionProof` ends
   `return typeof proof === 'string' ? proof : undefined;`. `''` is a string,
   so it is handed back verbatim.
2. `evictUnnamedAcquisition`'s predicate opens `typeof proof !== 'string'`, so
   it short-circuits and never clears.
3. `ensureSessionWindow`: `acquisitionOutcomeKey('')` is null, and the
   fail-closed guard is `typeof proof !== 'string'`, so neither fires. The gate
   returns `{ ready: true, proof: '' }`.

Downstream, no consumer compares against the self-custody `null`. They all test
truthiness, so `''` is indistinguishable from "this account needs no proof":

- `freshAuthWindowReady` returns `true` and shows no toast. The page starts the
  work.
- `uploadFile` and `retryOnce` take `if (!proof) return uploadFileToIpfs(file)`,
  the unproofed call self-custody uses. `api.js` then throws
  `FRESH_AUTH_REQUIRED` for a light account with no proof. That return sits
  AHEAD of `uploadFile`'s `try`, so the error escapes as a raw
  `ApiRequestError` rather than an `UploadSessionError`, no retry runs, and
  `describeUploadError` falls to its default. The user is told the upload
  failed, never that re-authentication is what they need, even though the
  throw carries `reason: 'missing'`, which is a remintable reason.
- `signer.js` does `if (freshAuthProof) body.fresh_auth_proof = freshAuthProof;`,
  so the broadcast leaves with the field absent and is refused by the backend a
  round-trip later.
- `cacheSessionProof('')` writes the slot, and the next `readSessionWindow`

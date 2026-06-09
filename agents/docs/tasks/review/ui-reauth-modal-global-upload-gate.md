# UI-REAUTH-MODAL-GLOBAL-UPLOAD-GATE — serialize the re-auth prompt across upload surfaces

**Owner:** UI Agent
**Created:** 2026-06-09 (architect follow-up from the `ui-ipfs-upload-token-roundtrip` re-review)
**Priority:** P3

## Problem

The light-account upload re-auth prompt is the singleton `Alpine.store('reauthModal')`. Its `request()`
uses a refuse-while-open guard: when a request is already awaiting a decision, a second concurrent
`request()` resolves to `null` (modeled on broadcast-confirm). `ui-ipfs-upload-token-roundtrip`
serialized image uploads WITHIN a single editor instance (`_imageUploadQueue`), but two INDEPENDENT
upload surfaces can still collide on the singleton modal:

- an editor inline-image upload (`uploadFile` → `createUploadSession` → `reauthModal.request()`), and
- a publish/edit page supplementary-file batch (`createUploadSession` held across the batch →
  `reauthModal.request()`).

If both are active at once (e.g. the user drops an image into the body editor and immediately hits
Submit while it is still uploading), the second `request()` resolves to `null`, so the loser surfaces
`UPLOAD_CANCELLED` and silently drops its upload.

This is pre-existing and low-probability (requires concurrent compose + submit on a light account). It
was explicitly accepted as out-of-scope for `ui-ipfs-upload-token-roundtrip` — the editor-local
serialization satisfied that task's Fix 2. This task tracks the cross-surface gate the editor-local
queue does not cover.

## Goal

Make a light account's re-auth prompt serialize across ALL upload surfaces so no upload is silently
cancelled by a concurrent one. Two candidate shapes (pick at implementation; if the chosen shape changes
the `reauthModal` contract, confirm with the architect first):

1. **FIFO queue in `reauthModal.request()`** — instead of resolving the second caller to `null`, queue
   waiters and serve them in order (one prompt resolves, then the next). This changes the
   refuse-while-open contract, so verify the broadcast-confirm-style callers that rely on
   refuse-while-open are not regressed.
2. **Shared "upload in progress" gate** — a process-wide flag so a second upload session waits for (or is
   briefly blocked by) the first rather than racing the modal, leaving `reauthModal`'s contract untouched.

## Acceptance

- An editor inline-image upload and a publish/edit supplementary batch running concurrently on a light
  account both complete (or cleanly queue), with no `UPLOAD_CANCELLED` from modal contention.
- The Keychain/self-custody path (which does not use the shared modal) is unaffected.
- `reauthModal`'s existing non-upload callers keep their current behavior, OR the contract change is
  documented and those callers re-verified.

## References

- `frontend/src/components/reauth-modal.js` — the singleton store + refuse-while-open `request()`.
- `frontend/src/lib/ipfs-upload.js` — `createUploadSession` / `ensureCredential`.
- `frontend/src/editor.js` — `_drainImageUploadQueue` → `uploadFile`.
- `frontend/src/pages/publish.js`, `frontend/src/pages/edit.js` — the page-level batch sessions.
- Origin: `ui-ipfs-upload-token-roundtrip` (the cross-surface case the editor-local queue did not cover).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI implementation note (2026-06-09, commit 8367faed on main)

**Chosen shape: option 2 (shared upload-layer gate), NOT a FIFO inside reauthModal.**
The contract change in option 1 is unnecessary, so no architect confirmation was
needed per the task's "if the chosen shape changes the reauthModal contract,
confirm first."

**Implementation.** A process-wide prompt-serialization gate in
`frontend/src/lib/ipfs-upload.js`: a module-level `promptChain` (a promise chain)
and `withPromptLock(requestPrompt)` that queues each caller behind the in-flight
prompt and advances the chain on settle (resolve OR reject, so a cancelled/failed
prompt never wedges the next waiter). `ensureCredential` now wraps its
`Alpine.store('reauthModal').request()` call in `withPromptLock(...)`. Because
every upload surface (the editor's one-shot `uploadFile` session and the
publish/edit page-batch `createUploadSession`) routes through `ensureCredential`,
the gate covers them transparently — **no edits to `editor.js`, `publish.js`, or
`edit.js` were needed.** The State-C block (`hasPassword === false`) still throws
before acquiring the gate, so a passwordless account never holds it.

**Why option 2 is the right depth (acceptance: contract untouched).** The two
genuinely-concurrent prompt requesters are both in the upload domain and on the
same page surface. `reauthModal`'s only other caller,
`frontend/src/lib/settings-fresh-auth.js`, lives on the settings page, prompts
strictly sequentially (it awaits the first `request()` fully before any
re-prompt), and cannot realistically race an upload. So the concurrency is a
property of the upload layer's fan-in; confining the gate there matches where the
problem originates and leaves the modal a dumb collector (as its docblock
intends). The Keychain/self-custody path returns before `ensureCredential`, so it
is ungated and unprompted (acceptance criterion 2).

**Tests** (`tests/unit/lib-ipfs-upload.test.js`, new `describe('cross-surface
prompt serialization')`). The reauthModal mock models the REAL refuse-while-open
contract (a `request()` while one is open resolves `null`), so the test fails if
the gate is removed (the second session would hit that branch → `UPLOAD_CANCELLED`
→ the assertion that both complete fails). Two `it`s: two concurrent light
sessions keep `maxConcurrent` open prompts at 1 and both complete uncancelled; the
self-custody path is ungated and unprompted.

**Verification.** `tests/unit/lib-ipfs-upload.test.js` green — 17 pass (up from
15). Full frontend unit suite green — 1436 pass (0 failures; the 3
`pages-edit.test.js` `_mountEditors` unhandled rejections are PRE-EXISTING,
confirmed by re-running with this change stashed). `npm run build` green. Not
E2E-run (the collision needs concurrent compose+submit on the full stack; unit
tests model the modal contract directly). A `/simplify` pass (4 agents:
reuse/simplification/efficiency/altitude) ran clean — altitude explicitly
confirmed option 2 is the correct depth; one minor `[...deduped]`-spread
simplification in the separate `notifications.js` task was intentionally not
folded in here (that file is already in `review/`, and the spread is a defensible
non-mutating idiom with negligible cost).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

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

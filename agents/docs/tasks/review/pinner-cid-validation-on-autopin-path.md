# PINNER-CID-VALIDATION-ON-AUTOPIN-PATH — ValidateCID on the discovery → backend.Pin path

**Owner:** pinner
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-6-correctness-reviewer.md`)
**Priority:** P0 (partial — HTTP entry already validates; autopin path does not)

## Context

The pinner has two CID entry points:

1. **HTTP API** (`/api/pin/<cid>`, `/api/unpin/<cid>`) — `pinner/server.go` calls `ValidateCID` before forwarding to the backend.
2. **Autopin from Hive discovery** — `pinner/discovery.go` extracts CIDs from `json_metadata->'ipfs_cid'` and `supplementary_files[].cid`, then `pinner/main.go` (or the autopin callback) hands them directly to `backend.Pin(ctx, cid)` without `ValidateCID`.

Inside `EmbeddedNode.Pin`, `filepath.Join(n.dataDir, "blocks", cid)` is called against the unvalidated CID. A malicious Hive post can set `supplementary_files[].cid = "../../../etc/cron.d/evil"` or `"..\\..\\windows-only-but-still"`. The path-traversal write happens under the pinner UID.

The HTTP-entry validation is reachable for hostile callers only if they can reach the pinner's API port (typically firewalled). The autopin path is reachable by **any Hive author** with a single broadcast.

## Goal

Add `ValidateCID` defensively at two layers:

1. **Discovery filter.** In `pinner/discovery.go`, validate each CID extracted from `ipfs_cid` and `supplementary_files[].cid` before yielding a `DiscoveredItem`. Invalid CIDs are logged and dropped.
2. **Backend entry guard.** In every `Backend.Pin` / `Backend.Unpin` / `Backend.IsPinned` implementation (`EmbeddedNode`, `PinataBackend`), call `ValidateCID` as the first line. Belt-and-suspenders against future code paths that bypass discovery.

## Non-goals

- Strict v1-only enforcement. Accept v0 and v1 CIDs equally; `ValidateCID` already handles both.
- Stricter URL-segment guards on the gateway-serving path (`/ipfs/<cid>`) — handled separately by HTTP-mux routing.

## Acceptance

- `pinner/discovery.go` rejects invalid CIDs from `ipfs_cid` and each entry of `supplementary_files[]`, with a counter or log line per drop.
- `EmbeddedNode.Pin`, `EmbeddedNode.Unpin`, `EmbeddedNode.IsPinned`, and the Pinata equivalents validate the CID at entry and return an error on invalid input.
- A test in `pinner/` constructs a `DiscoveredItem` with `cid = "../../../etc/passwd"` and asserts both the discovery filter drops it and the backend would reject it if it slipped through.

## References

- Audit chunk: `.context/audit-2026-04-21/chunk-6-correctness-reviewer.md` (P0: CID path traversal from HAF).

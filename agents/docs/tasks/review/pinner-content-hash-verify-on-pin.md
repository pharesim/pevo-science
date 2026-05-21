# PINNER-CONTENT-HASH-VERIFY-ON-PIN — Verify multihash while streaming gateway content

**Owner:** pinner
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-6-correctness-reviewer.md` + `chunk-6-reliability-reviewer.md`)
**Priority:** P0

## Context

`pinner/ipfsnode.go` `EmbeddedNode.Pin`: when no peer has the CID, the pinner fetches from `publicGateways` (Cloudflare, ipfs.io, etc.) and writes the response body straight to `blocks/<cid>` via `io.Copy(f, resp.Body)`. The CID name is never re-derived from the bytes that were written. The pinner then serves those bytes from its own `/ipfs/<cid>` gateway as if they were authoritative.

Any single compromised or misconfigured public gateway can poison the pinner's local store with content that does not hash to `<cid>`. Every PEvO reader who fetches the paper through the pinner will get the poisoned bytes.

## Goal

Compute the multihash of the streamed bytes while copying, and reject the write if the result does not match the CID being pinned.

1. Use `github.com/ipfs/go-cid` and `github.com/multiformats/go-multihash` (already part of the ecosystem if not yet imported).
2. Wrap the read side in a hashing reader (e.g. `io.TeeReader(resp.Body, hasher)`), where `hasher` is constructed from the multihash code of the parsed CID.
3. After `io.Copy` completes, compare `hasher.Sum(nil)` against the multihash digest extracted from the CID. On mismatch: `os.Remove(path)`, do not record the pin, advance to the next gateway.
4. Pair this with the size-cap task (`pinner-response-size-cap-on-gateway-fetch.md`) — the LimitedReader wraps `resp.Body`, the TeeReader wraps the LimitedReader. Order matters: size limit first so a poisoned-and-huge response gets cut off before the hash check sees absurd memory pressure.

## Non-goals

- v0 CID hash code handling beyond what `go-cid` exposes natively. If a v0 CID lands at this path, parse normally and verify against the implied `sha2-256` digest.
- Verifying content fetched via `io.IsPinned`'s peer-discovery branch — that path already trusts the IPFS subsystem to verify on read.
- Retrying on hash mismatch beyond moving to the next gateway in the list.

## Acceptance

- The pin path in `EmbeddedNode.Pin` rejects gateway responses whose multihash does not match the requested CID.
- The reject path removes the partial file and logs the gateway URL + actual vs expected digest.
- A unit test in `pinner/` constructs an `*httptest.Server` returning bytes that hash to a different CID and asserts `Pin` fails.
- No new pin is recorded in `pins.json` for the failed CID.

## References

- Audit chunk: `.context/audit-2026-04-21/chunk-6-correctness-reviewer.md` (P0: gateway content not hash-verified).
- Pairs with: `pinner-response-size-cap-on-gateway-fetch.md`.

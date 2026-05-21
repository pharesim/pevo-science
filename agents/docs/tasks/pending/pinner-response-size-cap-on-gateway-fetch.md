# PINNER-RESPONSE-SIZE-CAP-ON-GATEWAY-FETCH — Cap bytes copied from public IPFS gateways

**Owner:** pinner
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-6-correctness-reviewer.md`)
**Priority:** P0

## Context

`pinner/ipfsnode.go` `EmbeddedNode.Pin`:

```go
_, err = io.Copy(f, resp.Body)
```

`resp.Body` is a raw HTTP body from a public IPFS gateway. There is no upstream `Content-Length` check, no `LimitedReader` ceiling, and no streaming size accounting. A malicious or compromised gateway can stream unbounded bytes; a legitimate but huge CID (terabyte-sized) does the same thing accidentally.

Disk-fill DoS against the pinner host. One crafted Hive post referencing a poisoned CID is enough to wedge the pinner and, if `blocks/` shares a volume with other services, neighboring services too.

## Goal

Enforce a configurable byte ceiling on gateway fetches:

1. Add `MaxPinBytes int64` to the pinner config (env var `PINNER_MAX_PIN_BYTES`, default 256 MiB — well above any realistic PEvO paper PDF or supplementary archive, well below disk-fill territory).
2. Wrap `resp.Body` in `&io.LimitedReader{R: resp.Body, N: maxPinBytes + 1}` before `io.Copy`. After the copy, check whether the limit was reached: if `lr.N == 0`, the response hit the ceiling — reject, `os.Remove(path)`, try next gateway.
3. Layer with the hash-verify task (`pinner-content-hash-verify-on-pin.md`): size limit wraps the body, hash reader wraps the limited reader.

## Non-goals

- Dynamic per-CID size hints from Hive metadata (out of scope; metadata is attacker-controllable anyway).
- Quota accounting per uploader. Separate concern.
- Capping bytes for IPFS-protocol pins (peer-discovery path) — that path is already bounded by go-ipfs internals.

## Acceptance

- `EmbeddedNode.Pin` reads at most `maxPinBytes` from any gateway response.
- A unit test in `pinner/` constructs an `*httptest.Server` returning more bytes than the cap and asserts `Pin` aborts with a size-cap error.
- The default cap is documented in the pinner README / config struct comment.

## References

- Audit chunk: `.context/audit-2026-04-21/chunk-6-correctness-reviewer.md` (P0: no response-size limit).
- Pairs with: `pinner-content-hash-verify-on-pin.md`.

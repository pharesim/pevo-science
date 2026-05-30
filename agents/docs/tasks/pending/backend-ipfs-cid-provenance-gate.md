# BACKEND-IPFS-CID-PROVENANCE-GATE — gateway should gate on CID provenance, not just an accredited reference

**Owner:** Backend Agent
**Created:** 2026-05-30 (architect review of `backend-ipfs-gateway-content-type-and-cid-scope`)
**Priority:** P2 (content-spoofing under trusted origin + gateway bandwidth abuse; XSS already closed by CSP sandbox)

## Problem

The gateway's `cidIsKnown` (via `cidReferencedByAppTag(pool, cid, { requireAccreditedAuthor: true })`) proves only that *some currently-accredited author referenced the CID* in an APP_TAG comment. It does NOT prove the CID was ever pinned through PEvO. Because the chain is the SSoT and comments are broadcast client-side with fully attacker-authored `json_metadata`, any accredited account can self-whitelist an arbitrary externally-pinned CID by naming it in their own post, most cheaply via the image-markdown substring branch of the containment query (`img LIKE '%' || cid || '%'`), which matches a CID appearing anywhere in any `image[]` URL.

Effect: `GET /api/ipfs/<cid>` will proxy attacker-pinned bytes under the app origin. The per-route `Content-Security-Policy: sandbox` + `nosniff` close the same-origin script-execution chain, so the residual is **content-spoofing / phishing-under-trusted-origin** plus **unbounded gateway bandwidth-and-cache abuse** (the gateway proxies and caches arbitrarily large external blobs the uploader never sent through the size-limited upload path).

The gateway hardening task achieved its stated narrower goal (a *free unaccredited* account can no longer whitelist a CID). This task is the follow-up to decide whether the gateway should additionally require provenance.

## Options (architect/user to confirm before implementing)

1. **Accept + document the residual.** The CSP sandbox is the load-bearing control; treat trusted-origin content hosting by an accredited actor as an accepted residual and note it in `api-contracts/ipfs.md`. Cheapest. Pin the CSP-sandbox directive with a test that asserts it carries NO allow-tokens, since it becomes the only barrier.
2. **Gate the gateway on provenance.** Require the served CID to ALSO appear in `pending_ipfs_uploads` (i.e. it was actually pinned via `POST /api/ipfs/upload` by an accredited user), in addition to (or instead of) the chain-reference check.
3. **Drop the substring branch from the gateway predicate only.** Keep `img LIKE '%cid%'` on the cleanup path (over-inclusive is safe there) but remove it from the gateway's `requireAccreditedAuthor` query so a free-text markdown URL cannot whitelist a CID; require the structured `ipfs_cid` / `supplementary_files[].cid` position.

## Hard constraint

**Do NOT tighten the cleanup-job path.** `cidReferencedByAppTag` is shared with `ipfs-cleanup.ts`, where under-inclusiveness unpins a live on-chain-referenced file irreversibly. Any provenance gate must remain gateway-only (the existing `requireAccreditedAuthor` opt-in parameter is the model); the cleanup call must keep emitting the byte-identical, over-inclusive `$1..$4` query.

## Acceptance

1. The chosen posture is implemented gateway-only; the cleanup path's emitted SQL + params are unchanged (the existing default-path shape test still passes).
2. If option 2/3: a real-HAF test seeds an accredited author's comment whose ONLY reference to the attacker CID is via the image-substring branch, and asserts `cidIsKnown` returns false (gateway 404). Plus a positive test that a genuinely-uploaded/structured-reference CID still serves.
3. If option 1: the residual is documented in `api-contracts/ipfs.md` and a test pins that the `/api/ipfs/*` CSP header is exactly `sandbox` with no allow-tokens.

## References

- `backend/src/lib/ipfs-shared.ts` — `cidReferencedByAppTag` (the three OR-branches; the image-substring branch).
- `backend/src/routes/ipfs.ts` — `cidIsKnown`, the pending-row short-circuit.
- `backend/src/ipfs-cleanup.ts` — the over-inclusive cleanup consumer (must stay byte-identical).
- Archived task `ipfs-gateway-content-type-and-cid-scope` (tasks-archive.md) for the control-3 rationale.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

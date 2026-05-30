# BACKEND-IPFS-GATEWAY-CONTENT-TYPE-AND-CID-SCOPE — same-origin Content-Type passthrough + unaccredited CID whitelisting + SVG magic-byte gap

**Owner:** Backend Agent
**Created:** 2026-05-30 (security audit follow-up workflow)
**Priority:** P1 (same-origin script execution under `pevo.app` reachable by any free Hive account)

## Problem

Three composing defects in the IPFS surface let an attacker execute arbitrary same-origin script under the SPA's Origin:

**(a) Content-Type passthrough in `/api/ipfs/:cid`.** The proxy handler in `backend/src/routes/ipfs.ts` (`router.get('/:cid', ...)`) forwards `upstream.headers.get('content-type')` directly to the client via `res.setHeader('Content-Type', contentType)`. There is no served-Content-Type allow-list, no `Content-Disposition: attachment`, no per-route CSP, no `Cross-Origin-Resource-Policy` override. The route is mounted at `/api/ipfs/*` via `app.use('/api/ipfs', ipfsRouter)` in `backend/src/app.ts`, so responses share the SPA's Origin. An upstream Kubo gateway happily serves `text/html`, `image/svg+xml`, `application/javascript`, and `application/pdf` (with embedded JS) for arbitrary pinned CIDs.

**(b) `cidIsKnown` whitelists CIDs referenced by ANY Hive account under APP_TAG, no accreditation check.** The gate in `backend/src/lib/ipfs-shared.ts` (`cidReferencedByAppTag` / `cidIsKnown`) issues a containment query against the comments table filtering only on `c.tags @> [appTag]`. No JOIN against the accreditation table; no check that the referencing comment's author is accredited. A free unaccredited Hive account can broadcast a comment with `parent_permlink: 'pevotest'`, `tags: ['pevotest']`, and `json_metadata.pevotest.ipfs_cid: '<attackerCid>'` to whitelist any externally-pinned CID into the gateway.

**(c) SVG upload magic-byte check is substring-only.** In `backend/src/routes/ipfs.ts` the `validateMagicBytes` helper checks for the substring `<svg` in the first 1KB of the buffer for `image/svg+xml` uploads. `<script>`, `<foreignObject>`, event-handler attributes, and `javascript:` hrefs inside the SVG are not stripped. An accredited researcher (or any user via path (b)) can pin script-bearing SVG that the browser then parses as a scriptable document when fetched via `/api/ipfs/<cid>` with `Content-Type: image/svg+xml`.

The exploit chain: attacker pins `malicious.html` to any public IPFS node, broadcasts a free Hive comment under APP_TAG referencing the CID, then either shares `https://pevo.app/api/ipfs/<cid>` directly or links to it from a markdown post body (DOMPurify permits `<a href="/api/ipfs/...">`). Victim clicks; browser fetches and renders HTML same-origin; script reads `localStorage` (light-account posting/memo keys), calls `/api/*` with the victim's session, or phishes under the genuine `pevo.app` Origin.

## Goal

Layered fix — any single control would close the highest-impact path, but all three are cheap and reinforce each other:

1. **Strict Content-Type allow-list.** Define the set of MIMEs the gateway is willing to serve script-execution-safe (PDF, images excluding SVG, plain text, common archives, common document formats — mirror `ACCEPTED_MIMES` from the upload path). If upstream advertises anything outside the set, force `Content-Type: application/octet-stream` and `Content-Disposition: attachment; filename="<cid>"`. SVG: see (3) below.
2. **Per-route CSP sandbox + nosniff.** On every `/api/ipfs/*` response set `Content-Security-Policy: sandbox` (no allow-tokens — puts the response in an opaque origin so even `text/html` cannot read parent-origin storage), `X-Content-Type-Options: nosniff` (explicit; helmet's global is the same value but a per-route set survives middleware reordering), and `Cross-Origin-Resource-Policy: same-site`.
3. **Tighten `cidIsKnown` to accredited authors.** Extend the SQL in `cidReferencedByAppTag` (`backend/src/lib/ipfs-shared.ts`) to require the referencing comment satisfy `validPevoPaperWhere` OR (at minimum) the comment author exist in the active accreditations CTE. Reuse the shared `activeAccreditationsCteBody` discipline. A free unaccredited account must not be able to whitelist arbitrary CIDs into the gateway.
4. **Reject or sanitize SVG uploads.** Either (a) drop SVG from `ACCEPTED_MIMES` on the upload path entirely, or (b) run server-side DOMPurify (`isomorphic-dompurify` / `jsdom + DOMPurify`) over the buffer before pinning, stripping `<script>`, `<foreignObject>`, event-handler attributes, and `javascript:` hrefs. Implementer's call on (a) vs (b); (a) is simpler if SVG is not a load-bearing supplementary-file format.

## Acceptance

1. **Content-Type allow-list enforced.** Test: a mock upstream advertising `text/html`, `image/svg+xml`, `application/javascript`, or `application/xhtml+xml` results in the served response having `Content-Type: application/octet-stream` and `Content-Disposition: attachment; filename="<cid>"`. Mock upstream advertising `application/pdf` (or any allow-listed MIME) passes through unchanged.
2. **Per-route CSP + headers present.** Test: every response from `/api/ipfs/<cid>` carries `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, and `Cross-Origin-Resource-Policy: same-site`, regardless of MIME outcome above.
3. **`cidIsKnown` rejects unaccredited references.** Test: insert a comment with `tags: ['pevotest']` and `json_metadata.pevotest.ipfs_cid: '<cid>'` from a NON-accredited author; `cidIsKnown(cid)` returns `false`. Same comment from an accredited author returns `true`. Use the standard `activeAccreditationsCteBody` for the gate; the test seeds an accreditation row to flip the result.
4. **SVG path.** If (a) reject: upload of an SVG buffer returns 415/400; the existing upload tests for non-SVG MIMEs continue to pass. If (b) sanitize: upload of an SVG containing `<script>alert(1)</script>` succeeds, but the pinned content has the script element stripped (assert against the pinned buffer or its sha256).
5. **Mutation-kills:** revert each individual control (e.g., re-add `text/html` to the allow-list, drop the CSP header, drop the accreditation predicate from `cidIsKnown`, restore the substring-only SVG check) → at least one acceptance test goes RED per control.
6. **No regression in the legitimate upload + retrieval path.** Existing tests for PDF / image / common-doc upload and retrieval continue to pass; canonical paper-supplementary-file flow continues to work end-to-end.

## Out of scope

- Adding fresh-auth proof to the upload path (covered by `backend-ipfs-upload-bind-file-to-signature`).
- Pin garbage-collection or quota management on the new tightened `cidIsKnown` (existing pin-lifecycle logic stays as-is).
- Frontend changes to how supplementary-file links are rendered (markdown sanitizer already allows the `/api/ipfs/<cid>` href; the per-route CSP sandbox closes the exploit regardless).

## References

- `backend/src/routes/ipfs.ts` — `GET /:cid` proxy handler; `POST /upload` upload handler; `ACCEPTED_MIMES`; `validateMagicBytes`.
- `backend/src/lib/ipfs-shared.ts` — `cidReferencedByAppTag`, `cidIsKnown`.
- `backend/src/app.ts` — `app.use('/api/ipfs', ipfsRouter)` mount; existing helmet/CSP config.
- `backend/src/lib/activeAccreditationsCteBody.ts` (or whichever file currently exports it) — the shared CTE to reuse for the accreditation predicate.
- `frontend/src/components/markdown-renderer.js` — confirms DOMPurify permits `<a href>` (so links to `/api/ipfs/<cid>` reach the user from any post body).
- MDN: `Content-Security-Policy: sandbox` directive (opaque-origin semantics).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend implementation note (2026-05-30)

Landed all four controls. Two items for the architect at review:

**[TODO Architect] `api-contracts/ipfs.md` contract updates.** Two behavioral
changes affect the documented IPFS surface:
1. **Upload no longer accepts SVG.** `image/svg+xml` was dropped from the
   accepted MIME set (control 4, reject-not-sanitize). The accepted-types list
   in the contract (and the `POST /api/ipfs/upload` 422 message, now "PDF, PNG,
   JPEG, GIF, WebP, CSV, ZIP") should drop SVG.
2. **`GET /api/ipfs/:cid` now serves non-allow-listed upstream MIME types as
   `application/octet-stream` with `Content-Disposition: attachment`, and sets
   `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, and
   `Cross-Origin-Resource-Policy: same-site` on every response.** If the contract
   documents response headers / content-type behavior for the gateway, note this.

**Deviation from the fix sketch (control 3, intentional).** The task said to
extend `cidReferencedByAppTag` to require an accredited author. That function is
shared with the orphan-cleanup job (`ipfs-cleanup.ts`), where tightening the
in-use predicate would unpin a live on-chain-referenced file once its author
lost accreditation — irreversible, and the file's own docblock forbids
under-inclusiveness on the cleanup side. So the accreditation gate is opt-in via
a new `requireAccreditedAuthor` parameter that ONLY the gateway's `cidIsKnown`
passes; the cleanup path keeps the byte-identical `$1..$4` query. This satisfies
the task's "existing pin-lifecycle logic stays as-is" out-of-scope clause while
closing the gateway-whitelisting hole.

## Architect re-review (2026-05-30) — HELD PENDING FIXES:

`/ce-code-review` confirmed all four controls work and compose; the same-origin script-execution chain is closed (CSP `sandbox` + nosniff are the load-bearing backstop). Two items before archive:

1. **`GATEWAY_SAFE_MIMES` comment is now false + no linkage to `ACCEPTED_MIMES`.** The "Mirrors ACCEPTED_MIMES minus SVG" comment no longer holds (SVG is gone from both; the two sets are byte-identical), and there is no mechanical linkage — a future MIME added to the upload accept-list will be silently served as octet-stream by the gateway. Either correct the comment to describe the deliberate-divergence intent, or derive `GATEWAY_SAFE_MIMES` from `ACCEPTED_MIMES` so they can't drift.
2. **Test-header carve-out clause (b) is factually wrong.** `ipfs-gateway-hardening.test.ts` claims SVG rejection "fires at multer's fileFilter before any auth/accred work", but `verifyHiveSignature` runs first (before the inline handler that invokes multer). The crypto bypass is justified by the file-type-gate focus, not by pre-auth ordering — correct the rationale text.

Not blocking (handled elsewhere): the accreditation gate's provenance limitation (an accredited account can self-whitelist an external CID) is tracked in `backend-ipfs-cid-provenance-gate`. PDF-inline / CORP-same-site / negative-CID-cache are accepted residuals. Acceptance-#3's real-DB unaccredited→false flip is covered at the SQL-shape + mock-pool behavioral + accredited-real-path levels (real unaccredited HAF seeding is impractical) — no further test required.

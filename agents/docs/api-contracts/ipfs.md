# PEvO API Contract — IPFS

Endpoints for file upload and IPFS gateway proxy.

---

### POST /api/ipfs/upload

Upload a file and pin it to IPFS. Uses the local Kubo node by default; falls back to Pinata when configured and Kubo is unavailable.

**Request:** `multipart/form-data` with a `file` field (max size set by `MAX_UPLOAD_SIZE` config).

**Accepted types:** PDF, PNG, JPEG, GIF, WebP, SVG, CSV, ZIP. Magic bytes are validated server-side.

**Headers:** `X-Hive-Username` and `X-Hive-Signature` — the user must sign the file's SHA-256 hash with Hive Keychain to prove they are an accredited user.

**Rate limit:** 10 requests per account per hour.

**Response `data`:**

```json
{
  "cid": "QmXyz...",
  "size": 2048576,
  "filename": "paper.pdf",
  "type": "application/pdf"
}
```

**Errors:**
- `UNAUTHORIZED` — invalid signature
- `FORBIDDEN` — user is not accredited
- `INVALID_FILE_TYPE` — unsupported type or magic bytes mismatch
- `FILE_TOO_LARGE` — exceeds configured size limit

---

### GET /api/ipfs/:cid

Validated IPFS gateway proxy. Serves file content only for CIDs referenced by known PEvO papers (checked against HAF metadata and Redis pending uploads). Unknown CIDs return 404.

**Rate limit:** 60 requests per minute per IP.

**Response:** Streams the file content with appropriate `Content-Type` and `Cache-Control: public, max-age=31536000, immutable` headers.

**Errors:**
- `BAD_REQUEST` — invalid CID format
- `NOT_FOUND` — CID not referenced by any PEvO paper
- `INTERNAL_ERROR` (502) — IPFS gateway unavailable

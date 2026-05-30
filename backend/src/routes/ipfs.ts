import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount, byIp } from '../middleware/rateLimit.js';
import { getAccreditation } from './profile.js';
import { getRedis } from '../redis.js';
import { getPool, isHafConfigured } from '../db.js';
import { getAppPool } from '../app-db.js';
import { logger } from '../logger.js';
import { type PinBackend, cidReferencedByAppTag, unpinFromIpfs } from '../lib/ipfs-shared.js';
import { consumeSessionFreshAuthToken } from '../lib/fresh-auth.js';
import { issueUploadToken, consumeUploadToken } from '../lib/ipfs-upload-token.js';
import multer from 'multer';

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
}

const ipfsUploadLimiter = rateLimit({ name: 'ipfs-upload', windowMs: 60 * 60_000, max: 10, keyFn: byAccount });
// The upload-token pre-flight gets its own, more generous bucket so it does not
// consume the pin quota above: a multi-file paper needs one pre-flight per file,
// and sharing the bucket would halve the effective uploads/hour. The pre-flight
// only mints a single-use 60s token (no pin, no chain write), so abuse is already
// bounded by the token TTL; the strict pin cap stays on POST /upload.
const ipfsUploadTokenLimiter = rateLimit({ name: 'ipfs-upload-token', windowMs: 60 * 60_000, max: 30, keyFn: byAccount });

const router = Router();

// Defense-in-depth headers on every /api/ipfs/* response. The gateway proxies
// arbitrary pinned bytes, so even with the Content-Type allow-list below these
// reinforce isolation: `Content-Security-Policy: sandbox` (no allow-tokens)
// drops the response into an opaque origin so even a text/html body cannot read
// the parent origin's localStorage (light-account keys) or call same-origin
// APIs; `nosniff` stops a forced octet-stream from being MIME-sniffed back into
// HTML; `Cross-Origin-Resource-Policy: same-site` limits cross-site embedding.
// Set per-route so the guarantee survives any future reordering of the global
// helmet config. Harmless on the JSON upload response (JSON is not a document).
router.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
});

const MAX_FILE_SIZE = config.maxUploadSize;

// ──────────────────────────────────────────────
// Accepted MIME types and magic bytes validation
// ──────────────────────────────────────────────

// SVG is intentionally excluded: it is an XML document the browser parses as a
// scriptable document (inline <script>, <foreignObject>, event-handler attrs,
// javascript: hrefs), and the substring magic-byte check could not strip those.
// Rejecting it on upload removes the scriptable-supplementary-file class
// entirely rather than trying to sanitize it.
const ACCEPTED_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/csv',
  'application/zip',
]);

function validateMagicBytes(buffer: Buffer, mimetype: string): boolean {
  switch (mimetype) {
    case 'application/pdf':
      return buffer.subarray(0, 5).toString('ascii').startsWith('%PDF-');
    case 'image/png':
      return buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    case 'image/jpeg':
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/gif':
      return buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'GIF8';
    case 'image/webp':
      return buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'application/zip':
      return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
    case 'text/csv':
      return true; // MIME check only
    default:
      return false;
  }
}

const ACCEPTED_TYPES_MSG = 'Accepted file types: PDF, PNG, JPEG, GIF, WebP, CSV, ZIP';

// MIME types the download gateway is willing to serve with their advertised
// Content-Type. Anything outside this set (text/html, image/svg+xml,
// application/javascript, application/xhtml+xml, ...) is forced to an inert
// octet-stream attachment so a pinned CID cannot execute script under the SPA's
// origin. Mirrors ACCEPTED_MIMES minus SVG (scriptable) — the upload path no
// longer accepts SVG, but an externally-pinned CID reached via a chain
// reference could still advertise it upstream.
const GATEWAY_SAFE_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/csv',
  'application/zip',
]);

// Decide the Content-Type the gateway serves for a proxied response. The bare
// MIME (charset/params stripped) must be in GATEWAY_SAFE_MIMES to pass through;
// anything else is served as an inert octet-stream attachment so a pinned
// HTML/SVG/JS CID cannot execute script under the SPA's origin. Exported for
// direct unit testing of the allow-list decision.
export function gatewaySafeContentType(
  rawContentType: string | null,
  cid: string,
): { contentType: string; disposition?: string } {
  const bareMime = (rawContentType || '').split(';')[0].trim().toLowerCase();
  if (bareMime && GATEWAY_SAFE_MIMES.has(bareMime)) {
    return { contentType: rawContentType as string };
  }
  return { contentType: 'application/octet-stream', disposition: `attachment; filename="${cid}"` };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ACCEPTED_MIMES.has(file.mimetype)) {
      cb(new Error('INVALID_FILE_TYPE'));
      return;
    }
    cb(null, true);
  },
});

// ──────────────────────────────────────────────
// IPFS pinning via Kubo HTTP API
// ──────────────────────────────────────────────

interface PinResult {
  cid: string;
  size: number;
  backend: PinBackend;
}

async function pinToKubo(buffer: Buffer, filename: string): Promise<PinResult> {
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(buffer)]), filename);

  const response = await fetch(`${config.ipfsApiUrl}/api/v0/add?pin=true`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kubo API error: ${response.status} ${text}`);
  }

  const data = await response.json() as { Hash: string; Size: string };
  return { cid: data.Hash, size: parseInt(data.Size, 10), backend: 'kubo' };
}

async function pinToPinata(buffer: Buffer, filename: string): Promise<PinResult> {
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(buffer)]), filename);
  formData.append('pinataMetadata', JSON.stringify({ name: filename }));

  const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: {
      pinata_api_key: config.pinataApiKey,
      pinata_secret_api_key: config.pinataSecretKey,
    },
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pinata API error: ${response.status} ${text}`);
  }

  const data = await response.json() as { IpfsHash: string; PinSize: number };
  return { cid: data.IpfsHash, size: data.PinSize, backend: 'pinata' };
}

async function pinToIpfs(buffer: Buffer, filename: string): Promise<PinResult> {
  if (config.ipfsApiUrl) {
    try {
      return await pinToKubo(buffer, filename);
    } catch (err) {
      if (!config.pinataApiKey) throw err;
      logger.warn({ err: (err as Error).message }, 'Kubo upload failed, falling back to Pinata');
    }
  }

  if (config.pinataApiKey && config.pinataSecretKey) {
    return await pinToPinata(buffer, filename);
  }

  throw new Error('No IPFS backend available — configure IPFS_API_URL or Pinata keys');
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// ──────────────────────────────────────────────
// POST /api/ipfs/upload-token — bind a declared file to the auth envelope
// ──────────────────────────────────────────────
//
// Pre-flight that mints a single-use token scoped to a declared file sha256.
// The actual upload then proves it carries the same bytes. Two properties:
//
//  - **File binding.** On the signature path, verifyHiveSignature body-hashes
//    this JSON pre-flight into the signed envelope, so a captured signature is
//    bound to one file_sha256. The upload re-checks sha256(file.buffer) against
//    the token, so a captured pre-flight cannot pin a different file.
//  - **No JWT-only pinning.** A Bearer JWT is replayable, so the JWT path
//    additionally requires a single-use session fresh-auth proof (ARCH.md § 6.5
//    invariant #1). The per-request signature path is itself fresh and needs no
//    extra proof. A stolen JWT alone therefore cannot obtain a token, and
//    without a token the upload is refused.
router.post('/upload-token', verifyHiveSignature, ipfsUploadTokenLimiter, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;

  if (req.hiveAuthMethod === 'jwt') {
    const proofRaw = (req.body as { fresh_auth_proof?: unknown })?.fresh_auth_proof;
    const proofToken = typeof proofRaw === 'string' ? proofRaw : undefined;
    const result = await consumeSessionFreshAuthToken(proofToken, username);
    if (!result.valid) {
      const status = result.reason === 'username_mismatch' ? 403 : 401;
      return sendError(
        res,
        status,
        'FRESH_AUTH_REQUIRED',
        'Re-authentication required to request an upload token. Please complete the fresh-auth challenge and retry.',
        { reason: result.reason },
      );
    }
  }

  const body = (req.body ?? {}) as { file_sha256?: unknown; mimetype?: unknown; size?: unknown };
  const fileSha256 = typeof body.file_sha256 === 'string' ? body.file_sha256.toLowerCase() : '';
  const mimetype = typeof body.mimetype === 'string' ? body.mimetype : '';
  const size = typeof body.size === 'number' ? body.size : NaN;

  if (!SHA256_HEX_RE.test(fileSha256)) {
    return sendError(res, 400, 'BAD_REQUEST', 'file_sha256 must be a 64-character hex SHA-256 digest');
  }
  if (!ACCEPTED_MIMES.has(mimetype)) {
    return sendError(res, 422, 'INVALID_FILE_TYPE', ACCEPTED_TYPES_MSG);
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_SIZE) {
    return sendError(res, 413, 'FILE_TOO_LARGE', `File exceeds ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB limit`);
  }

  // Same accreditation gate as the upload itself — fail fast at the pre-flight.
  const accreditation = await getAccreditation(username);
  if (!accreditation) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can upload files');
  }

  const token = await issueUploadToken({ account: username, file_sha256: fileSha256, mimetype, size });
  sendOk(res, { upload_token: token, expires_in: 60 });
});

// ──────────────────────────────────────────────
// POST /api/ipfs/upload
// ──────────────────────────────────────────────

router.post('/upload', verifyHiveSignature, ipfsUploadLimiter, (req: Request, res: Response) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.message === 'INVALID_FILE_TYPE') {
        return sendError(res, 422, 'INVALID_FILE_TYPE', ACCEPTED_TYPES_MSG);
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return sendError(res, 413, 'FILE_TOO_LARGE', `File exceeds ${Math.round(config.maxUploadSize / (1024 * 1024))}MB limit`);
      }
      return sendError(res, 400, 'BAD_REQUEST', err.message);
    }

    if (!req.file) {
      return sendError(res, 400, 'BAD_REQUEST', 'No file provided');
    }

    // Validate magic bytes for the claimed MIME type
    if (!validateMagicBytes(req.file.buffer, req.file.mimetype)) {
      return sendError(res, 422, 'INVALID_FILE_TYPE', `File content does not match claimed type ${req.file.mimetype}`);
    }

    // Verify uploader is accredited
    const accreditation = await getAccreditation(req.hiveUsername!);
    if (!accreditation) {
      return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can upload files');
    }

    // Single-use upload-token gate. The token was minted by /upload-token under
    // a freshly-authenticated pre-flight (signed request, or JWT + fresh-auth),
    // scoped to a declared file sha256. Consuming it here and matching the
    // actual file bytes binds the upload to that envelope: a stolen JWT cannot
    // pin (no token), and a captured pre-flight cannot pin a different file
    // (sha256 mismatch).
    const uploadToken = req.headers['x-upload-token'] as string | undefined;
    const binding = await consumeUploadToken(uploadToken, req.hiveUsername!);
    if (!binding) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        'A valid single-use upload token is required. Request one from /api/ipfs/upload-token first.',
      );
    }
    const actualSha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    if (actualSha256 !== binding.file_sha256) {
      return sendError(
        res,
        400,
        'BAD_REQUEST',
        'Uploaded file does not match the sha256 declared for this upload token.',
      );
    }

    if (!config.ipfsApiUrl && !config.pinataApiKey) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'IPFS not configured. Set IPFS_API_URL or Pinata keys.');
    }

    // Refuse the pin entirely when the durable tracking store is unavailable.
    // The cleanup job scans `pending_ipfs_uploads` to find orphans; a pin
    // without a row is undetectable orphan storage forever. Better a 503
    // than a guaranteed silent leak.
    const appPool = getAppPool();
    if (!appPool) {
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'IPFS upload tracking unavailable. Try again later.',
      );
    }

    try {
      const safeName = sanitizeFilename(req.file.originalname);
      const result = await pinToIpfs(req.file.buffer, safeName);

      // Durable tracking for orphan cleanup — Postgres is authoritative.
      // The insert is load-bearing for the success response: if it fails,
      // we compensate by unpinning so we leave neither a DB row nor a live
      // pin (cleanup job's two-state model: in `pending_ipfs_uploads` OR
      // referenced on-chain; an untracked live pin is the orphan class
      // this defends against).
      try {
        await appPool.query(
          `INSERT INTO pending_ipfs_uploads (cid, uploader_account, size_bytes, pin_backend)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (cid) DO NOTHING`,
          [result.cid, req.hiveUsername, result.size, result.backend],
        );
      } catch (dbErr) {
        // The success response is withheld until the row exists, so a failed
        // insert normally means no row landed and the pin must be released to
        // avoid an undetectable orphan. But a rejection does NOT prove the row
        // is absent: a concurrent upload of the same content/CID may have
        // already committed its row (Kubo pins are not refcounted, so a blind
        // unpin would kill the live pin that request's 200 already
        // referenced), or our own insert may have committed server-side before
        // the connection dropped on the ack. Both make an unconditional unpin
        // destroy data a committed row depends on — the inverse of the orphan
        // this path defends against. So confirm the row is absent before
        // compensating; if the existence check itself cannot run, bias toward
        // NOT unpinning — a tolerated orphan (the cleanup job can still reap a
        // genuinely-unreferenced pin later) beats guaranteed data loss.
        // Residual window: a row that commits in the gap between this check and
        // the unpin is not covered, but that window is far narrower than the
        // unconditional-unpin it replaces.
        logger.error({ err: dbErr, cid: result.cid }, 'Failed to record pending IPFS upload in DB; checking row presence before compensating');

        let rowAbsent = false;
        try {
          const check = await appPool.query(
            `SELECT 1 FROM pending_ipfs_uploads WHERE cid = $1 LIMIT 1`,
            [result.cid],
          );
          // Match the file's other rowCount checks: a null rowCount (driver
          // could not report it) is not proof of absence, so it must not green-
          // light the unpin. null === 0 is already false, so behavior is
          // unchanged; the explicit guard keeps the conservative bias legible.
          rowAbsent = check.rowCount !== null && check.rowCount === 0;
        } catch (checkErr) {
          logger.error(
            { err: checkErr, cid: result.cid },
            'Could not confirm pending-upload row presence after insert failure; skipping unpin to avoid destroying a pin a committed row may depend on',
          );
        }

        if (rowAbsent) {
          try {
            await unpinFromIpfs(result.cid, result.backend);
          } catch (unpinErr) {
            // Compensation failed — the pin is now an orphan that the cleanup
            // job cannot see (no DB row). Log loudly; operator-side recovery
            // requires manual `pin rm` against the recorded CID. dbErr is
            // normalized to a string because pino's Error serializer only
            // fires on the `err` key (already carrying unpinErr here).
            logger.error(
              {
                err: unpinErr,
                cid: result.cid,
                backend: result.backend,
                dbErr: dbErr instanceof Error ? dbErr.message : String(dbErr),
              },
              'IPFS unpin compensation failed after DB insert error — orphan pin requires manual cleanup',
            );
          }
        }
        return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to record IPFS upload');
      }

      // Hot cache for the download proxy's known-CID check. Best-effort
      // below the load-bearing DB write — Postgres is authoritative, Redis
      // is optimization, so a failure here does not invalidate the response.
      const redis = getRedis();
      if (redis) {
        const trackingData = JSON.stringify({
          cid: result.cid,
          uploader: req.hiveUsername,
          timestamp: Date.now(),
        });
        await redis.set(`${config.appTag}:ipfs:pending:${result.cid}`, trackingData, 'EX', 86400).catch((err) => {
          logger.warn({ err, cid: result.cid }, 'Failed to track IPFS upload in Redis');
        });
      }

      sendOk(res, {
        cid: result.cid,
        size: result.size,
        filename: safeName,
        type: req.file.mimetype,
      });
    } catch (pinErr) {
      logger.error({ err: (pinErr as Error).message }, 'IPFS pin failed');
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to pin file to IPFS');
    }
  });
});

// ──────────────────────────────────────────────
// GET /api/ipfs/:cid — validated IPFS gateway proxy
// ──────────────────────────────────────────────

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{55,62})$/;

const ipfsDownloadLimiter = rateLimit({ name: 'ipfs-download', windowMs: 60_000, max: 60, keyFn: byIp });

async function cidIsKnown(cid: string): Promise<boolean> {
  // Check Redis pending uploads first (fast path)
  const redis = getRedis();
  if (redis) {
    const pending = await redis.get(`${config.appTag}:ipfs:pending:${cid}`);
    if (pending) return true;
  }

  // Durable pending-uploads record (Redis may have evicted the cache entry).
  const appPool = getAppPool();
  if (appPool) {
    const pendingRow = await appPool.query(
      `SELECT 1 FROM pending_ipfs_uploads WHERE cid = $1 LIMIT 1`,
      [cid],
    );
    if (pendingRow.rowCount !== null && pendingRow.rowCount > 0) return true;
  }

  // Check HAF for published references via the shared tags-scoped containment
  // query (cidReferencedByAppTag, lib/ipfs-shared.ts) — the same definition the
  // cleanup job's CID-in-use check consumes. The pending-row short-circuit above
  // stays ahead of this so a freshly-uploaded CID still resolves before it lands
  // on chain.
  if (!isHafConfigured()) return false;
  const pool = getPool();
  if (!pool) return false;

  // Gateway path requires the referencing comment's author to be accredited, so
  // a free unaccredited Hive account cannot whitelist an arbitrary
  // externally-pinned CID into the gateway. The pending-row short-circuit above
  // still serves a freshly-uploaded (accredited) CID before it lands on chain.
  return cidReferencedByAppTag(pool, cid, { requireAccreditedAuthor: true });
}

router.get('/:cid', ipfsDownloadLimiter, async (req: Request, res: Response) => {
  const cid = req.params.cid as string;

  if (!CID_RE.test(cid)) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid CID format');
  }

  try {
    const known = await cidIsKnown(cid);
    if (!known) {
      return sendError(res, 404, 'NOT_FOUND', 'Unknown CID');
    }

    // Build the gateway URL — if the configured URL already contains /ipfs/,
    // append the CID directly; otherwise add /ipfs/ before the CID.
    function gatewayUrlFor(cid: string): string | null {
      if (!config.ipfsGatewayUrl) return null;
      const base = config.ipfsGatewayUrl.replace(/\/+$/, '');
      return base.endsWith('/ipfs') ? `${base}/${cid}` : `${base}/ipfs/${cid}`;
    }

    // Proxy from gateway if available
    const gwUrl = gatewayUrlFor(cid);
    if (gwUrl) {
      const upstream = await fetch(gwUrl, {
        signal: AbortSignal.timeout(30_000),
      });

      if (upstream.ok && upstream.body) {
        // Content-Type allow-list: pass the upstream type through only if its
        // bare MIME is script-execution-safe; otherwise serve an inert
        // octet-stream attachment (defense-in-depth with the CSP sandbox above).
        const served = gatewaySafeContentType(upstream.headers.get('content-type'), cid);
        res.setHeader('Content-Type', served.contentType);
        if (served.disposition) res.setHeader('Content-Disposition', served.disposition);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

        const reader = upstream.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            if (!res.write(value)) {
              await new Promise<void>((resolve) => res.once('drain', resolve));
            }
          }
        };
        await pump();
        return;
      }
    }

    sendError(res, 502, 'INTERNAL_ERROR', 'IPFS gateway unavailable');
  } catch (err) {
    logger.error({ err: (err as Error).message, cid }, 'IPFS download proxy failed');
    sendError(res, 502, 'INTERNAL_ERROR', 'Failed to fetch from IPFS');
  }
});

export default router;

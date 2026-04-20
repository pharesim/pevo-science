import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount, byIp } from '../middleware/rateLimit.js';
import { getAccreditation } from './profile.js';
import { getRedis } from '../redis.js';
import { getPool, isHafAvailable } from '../db.js';
import { getAppPool } from '../app-db.js';
import { T } from '../hafsql.js';
import { logger } from '../logger.js';
import multer from 'multer';

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
}

const ipfsUploadLimiter = rateLimit({ name: 'ipfs-upload', windowMs: 60 * 60_000, max: 10, keyFn: byAccount });

const router = Router();

const MAX_FILE_SIZE = config.maxUploadSize;

// ──────────────────────────────────────────────
// Accepted MIME types and magic bytes validation
// ──────────────────────────────────────────────

const ACCEPTED_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
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
    case 'image/svg+xml': {
      // Strip BOM if present, check for <svg in first 1024 bytes
      let head = buffer.subarray(0, Math.min(1024, buffer.length));
      if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
        head = head.subarray(3);
      }
      return head.toString('utf8').includes('<svg');
    }
    case 'application/zip':
      return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
    case 'text/csv':
      return true; // MIME check only
    default:
      return false;
  }
}

const ACCEPTED_TYPES_MSG = 'Accepted file types: PDF, PNG, JPEG, GIF, WebP, SVG, CSV, ZIP';

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
  return { cid: data.Hash, size: parseInt(data.Size, 10) };
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
  return { cid: data.IpfsHash, size: data.PinSize };
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

    if (!config.ipfsApiUrl && !config.pinataApiKey) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'IPFS not configured — set IPFS_API_URL or Pinata keys');
    }

    try {
      const safeName = sanitizeFilename(req.file.originalname);
      const result = await pinToIpfs(req.file.buffer, safeName);

      // Durable tracking for orphan cleanup — Postgres is authoritative.
      const appPool = getAppPool();
      if (appPool) {
        await appPool.query(
          `INSERT INTO pending_ipfs_uploads (cid, uploader_account, size_bytes)
           VALUES ($1, $2, $3)
           ON CONFLICT (cid) DO NOTHING`,
          [result.cid, req.hiveUsername, result.size],
        ).catch((err) => {
          logger.error({ err, cid: result.cid }, 'Failed to record pending IPFS upload in DB');
        });
      }

      // Hot cache for the download proxy's known-CID check.
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

  // Check HAF for published references
  if (!isHafAvailable()) return false;
  const pool = getPool();
  if (!pool) return false;

  const result = await pool.query(
    `SELECT 1 FROM ${T.comments} c
     WHERE c.json_metadata @> $1::jsonb
        OR c.json_metadata @> $2::jsonb
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.json_metadata->'image') img
          WHERE img LIKE '%' || $3 || '%'
        )
     LIMIT 1`,
    [
      JSON.stringify({ pevo: { ipfs_cid: cid } }),
      JSON.stringify({ pevo: { supplementary_files: [{ cid }] } }),
      cid,
    ],
  );

  return result.rowCount !== null && result.rowCount > 0;
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
        const contentType = upstream.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
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

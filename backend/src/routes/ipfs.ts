import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { getAccreditation } from './profile.js';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';
import multer from 'multer';

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
}

const ipfsUploadLimiter = rateLimit({ name: 'ipfs-upload', windowMs: 60 * 60_000, max: 10, keyFn: byAccount });

const router = Router();

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

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

async function pinToIpfs(buffer: Buffer, filename: string): Promise<PinResult> {
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(buffer)]), filename);

  const response = await fetch(`${config.ipfsApiUrl}/api/v0/add?pin=true`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`IPFS API error: ${response.status} ${text}`);
  }

  const data = await response.json() as { Hash: string; Size: string };
  return { cid: data.Hash, size: parseInt(data.Size, 10) };
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
        return sendError(res, 413, 'FILE_TOO_LARGE', 'File exceeds 10MB limit');
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

    if (!config.ipfsApiUrl) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'IPFS node not configured');
    }

    try {
      const safeName = sanitizeFilename(req.file.originalname);
      const result = await pinToIpfs(req.file.buffer, safeName);

      // Track upload in Redis for orphan cleanup (I5a)
      const redis = getRedis();
      if (redis) {
        const trackingData = JSON.stringify({
          cid: result.cid,
          uploader: req.hiveUsername,
          timestamp: Date.now(),
        });
        await redis.set(`ipfs:pending:${result.cid}`, trackingData, 'EX', 86400).catch((err) => {
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

export default router;

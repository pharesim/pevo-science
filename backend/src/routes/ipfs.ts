import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { getAccreditation } from './profile.js';
import { logger } from '../logger.js';
import multer from 'multer';

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
}

const ipfsUploadLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, keyFn: byAccount });

const router = Router();

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB — reduced from 50MB to limit memory pressure

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      cb(new Error('INVALID_FILE_TYPE'));
      return;
    }
    cb(null, true);
  },
});

// ──────────────────────────────────────────────
// IPFS pinning abstraction
// ──────────────────────────────────────────────

interface PinResult {
  cid: string;
  size: number;
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
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pinata API error: ${response.status} ${text}`);
  }

  const data = await response.json() as { IpfsHash: string; PinSize: number };
  return { cid: data.IpfsHash, size: data.PinSize };
}

// ──────────────────────────────────────────────
// POST /api/ipfs/upload
// ──────────────────────────────────────────────

router.post('/upload', verifyHiveSignature, ipfsUploadLimiter, (req: Request, res: Response) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.message === 'INVALID_FILE_TYPE') {
        return sendError(res, 422, 'INVALID_FILE_TYPE', 'Only PDF files are accepted');
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return sendError(res, 413, 'FILE_TOO_LARGE', 'File exceeds 10MB limit');
      }
      return sendError(res, 400, 'BAD_REQUEST', err.message);
    }

    if (!req.file) {
      return sendError(res, 400, 'BAD_REQUEST', 'No file provided');
    }

    // Validate PDF magic bytes (%PDF-)
    const header = req.file.buffer.subarray(0, 5).toString('ascii');
    if (!header.startsWith('%PDF-')) {
      return sendError(res, 422, 'INVALID_FILE_TYPE', 'File is not a valid PDF (magic bytes check failed)');
    }

    // Verify uploader is accredited
    const accreditation = await getAccreditation(req.hiveUsername!);
    if (!accreditation) {
      return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can upload files');
    }

    if (!config.pinataApiKey || !config.pinataSecretKey) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'IPFS pinning service not configured');
    }

    try {
      const safeName = sanitizeFilename(req.file.originalname);
      const result = await pinToPinata(req.file.buffer, safeName);
      sendOk(res, {
        cid: result.cid,
        size: result.size,
        filename: safeName,
      });
    } catch (pinErr) {
      logger.error({ err: (pinErr as Error).message }, 'IPFS pin failed');
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to pin file to IPFS');
    }
  });
});

export default router;

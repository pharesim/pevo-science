import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { sendOk, sendError } from '../response.js';
import { config } from '../config.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';

const router = Router();
const SESSION_EXPIRY = '24h';
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Rate limit: 10 requests per verified username per hour
const sessionLimiter = rateLimit({ name: 'auth-session', windowMs: 3_600_000, max: 10, keyFn: byAccount });

router.post('/session', verifyHiveSignature, sessionLimiter, (req: Request, res: Response) => {
  const token = jwt.sign(
    { sub: req.hiveUsername },
    config.sessionSecret,
    { expiresIn: SESSION_EXPIRY },
  );
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS).toISOString();
  sendOk(res, { token, expires_at: expiresAt });
});

export default router;

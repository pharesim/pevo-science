import { Router, type Request, type Response } from 'express';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { validate, contactSchema } from '../validation.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'Bug Report',
  accreditation: 'Accreditation',
  keychain: 'Keychain/Hive',
  general: 'General',
};

const contactLimiter = rateLimit({ name: 'contact', windowMs: 3_600_000, max: 5, keyFn: byIp });

const router = Router();

// ──────────────────────────────────────────────
// POST /api/contact
// ──────────────────────────────────────────────

router.post('/', contactLimiter, validate(contactSchema), async (req: Request, res: Response) => {
  const { category, email, subject, message } = req.body;

  const label = CATEGORY_LABELS[category] || 'General';
  const fullSubject = `[${label}] ${subject}`;

  if (config.smtpHost) {
    try {
      const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
      });

      await transporter.sendMail({
        from: config.smtpFrom,
        to: config.contactEmail,
        replyTo: email,
        subject: fullSubject,
        text: `From: ${email}\nCategory: ${label}\n\n${message}`,
      });
    } catch (mailErr) {
      logger.error({ err: (mailErr as Error).message }, 'Failed to send contact form email');
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send message');
    }
  } else {
    logger.error('SMTP not configured — cannot send contact form email');
    return sendError(res, 500, 'INTERNAL_ERROR', 'Email service not configured');
  }

  sendOk(res, { message: 'sent' });
});

export default router;

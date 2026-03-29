import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { sendError } from './response.js';

// ─── Schemas ──────────────────────────────────────────────────────

export const accreditationRequestSchema = z.object({
  full_name: z.string().min(1).max(200),
  institution: z.string().min(1).max(200),
  field: z.string().min(1).max(100),
  email: z.string().email().max(254),
  orcid: z.string().max(50).optional().default(''),
});

export const accreditationVerifySchema = z.object({
  token: z.string().min(1).max(128),
});

export const anonymousReviewSchema = z.object({
  paper_author: z.string().min(1).max(50),
  paper_permlink: z.string().min(1).max(256),
  body: z.string().min(1).max(100_000),
  rating: z.object({
    methodology: z.number().int().min(1).max(5),
    novelty: z.number().int().min(1).max(5),
    clarity: z.number().int().min(1).max(5),
    significance: z.number().int().min(1).max(5),
  }),
});

export const contactSchema = z.object({
  category: z.enum(['bug', 'accreditation', 'keychain', 'general']),
  email: z.string().email().max(254),
  subject: z.string().min(1).max(200),
  message: z.string().min(10).max(5000),
  website: z.string().max(0).optional(), // honeypot — must be empty
});

// ─── Middleware factory ───────────────────────────────────────────

export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return sendError(res, 400, 'BAD_REQUEST', issues);
    }
    req.body = result.data;
    next();
  };
}

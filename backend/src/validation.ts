import { z } from 'zod';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
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

/**
 * Build a request-validation middleware bound to a Zod schema.
 *
 * The returned middleware:
 *  1. Runs `schema.safeParse(req.body)`. On failure, responds 400 `BAD_REQUEST`
 *     with a joined `path: message` issue summary and short-circuits the chain.
 *  2. On success, replaces `req.body` with `result.data` (Zod's parsed and
 *     coerced output) and calls `next()`. Subsequent middleware and the route
 *     handler observe the parsed value, not the raw incoming JSON.
 *
 * Typed-return contract: the middleware is returned as a
 * `RequestHandler<Record<string, string>, unknown, z.infer<T>>`, threading
 * the schema's inferred output type through Express's `ReqBody` generic.
 * `Record<string, string>` mirrors Express's `ParamsDictionary` and keeps
 * params readable as strings on the route handler. To make a downstream
 * route handler pick up `req.body: z.infer<typeof schema>` without a cast,
 * the handler's `Request` argument must annotate the same `ReqBody`
 * generic, e.g.
 *
 *   import type { Request } from 'express';
 *   import type { z } from 'zod';
 *
 *   router.post('/x', validate(mySchema), async (
 *     req: Request<Record<string, string>, unknown, z.infer<typeof mySchema>>,
 *     res,
 *   ) => {
 *     const { field } = req.body; // typed, no `as` cast
 *   });
 *
 * Without the handler-side annotation Express's per-handler typing defaults
 * `req.body` to `any`, since `router.post` does not propagate the previous
 * middleware's `ReqBody` to the next handler in the chain.
 *
 * @typeParam T - The Zod schema type. Inferred from the argument.
 * @param schema - A Zod schema describing the expected `req.body` shape.
 * @returns A typed Express request handler that validates and assigns
 *   `req.body` before delegating to the next handler.
 */
export function validate<T extends z.ZodTypeAny>(
  schema: T,
): RequestHandler<Record<string, string>, unknown, z.infer<T>> {
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

/**
 * Library-level tests for `handleArgonError`. Covers the three argon2
 * semaphore error classes and the unhandled fall-through path.
 *
 * These tests assert the public contract that two downstream tasks pinned
 * onto the helper's shape:
 *   - `backend-503-message-genericize.md` — both 503 branches share the
 *     single `SERVICE_UNAVAILABLE_MESSAGE` body string (no separate
 *     "authentication overloaded" / "shutting down" wording).
 *   - `backend-503-retry-after.md` — `Retry-After: 5` on queue-full,
 *     `Retry-After: 30` on shutdown, no header on abort, optional
 *     per-call override via `opts.retryAfterSec`.
 *
 * No real network or DB. We mock only the Express `Response` object and
 * the logger; the error classes themselves come from the real
 * `argon2-semaphore` module so `instanceof` matches the production code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import {
  handleArgonError,
  SERVICE_UNAVAILABLE_MESSAGE,
  QUEUE_FULL_RETRY_AFTER_SEC,
  SHUTDOWN_RETRY_AFTER_SEC,
  ARGON_REASON_QUEUE_FULL,
  ARGON_REASON_SHUTDOWN_DRAIN,
} from '../../src/lib/argon2-error-handler.js';
import {
  ArgonQueueFullError,
  ShuttingDownError,
  ArgonAbortError,
} from '../../src/lib/argon2-semaphore.js';
import { logger } from '../../src/logger.js';

function mockResponse() {
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('handleArgonError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Silence the helper's log calls so test output stays clean.
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined as unknown as void);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined as unknown as void);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
  });

  describe('ArgonQueueFullError → 503 + Retry-After: 5', () => {
    it('sends generic SERVICE_UNAVAILABLE_MESSAGE body, Retry-After: 5, and details.reason: queue_full', () => {
      const res = mockResponse();
      const outcome = handleArgonError(res, new ArgonQueueFullError());

      expect(outcome).toBe('handled');
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.set).toHaveBeenCalledWith('Retry-After', String(QUEUE_FULL_RETRY_AFTER_SEC));
      expect(res.set).toHaveBeenCalledWith('Retry-After', '5');
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: SERVICE_UNAVAILABLE_MESSAGE,
          details: { reason: ARGON_REASON_QUEUE_FULL },
        },
      });
      // Sentinel pin: catch a future drift of the wire literal away from
      // the documented `'queue_full'` value (the contract HTTP-only
      // canaries match against).
      expect(ARGON_REASON_QUEUE_FULL).toBe('queue_full');
      // Body string MUST NOT mention "authentication" or "argon"; that was
      // the information disclosure the genericize task closed.
      expect(SERVICE_UNAVAILABLE_MESSAGE).not.toMatch(/authentication/i);
      expect(SERVICE_UNAVAILABLE_MESSAGE).not.toMatch(/argon/i);
    });

    it('logs warn-level on the queue-full branch and merges logContext', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
      const res = mockResponse();
      const err = new ArgonQueueFullError();

      handleArgonError(res, err, { logContext: { username: 'alice' } });

      expect(warnSpy).toHaveBeenCalledWith(
        { err, username: 'alice' },
        'argon2 queue saturated — returning 503',
      );
    });

    it('honors opts.retryAfterSec override on queue-full branch', () => {
      const res = mockResponse();
      handleArgonError(res, new ArgonQueueFullError(), { retryAfterSec: 17 });

      expect(res.set).toHaveBeenCalledWith('Retry-After', '17');
      expect(res.set).not.toHaveBeenCalledWith('Retry-After', '5');
    });
  });

  describe('ShuttingDownError → 503 + Retry-After: 30', () => {
    it('sends generic SERVICE_UNAVAILABLE_MESSAGE body, Retry-After: 30, and details.reason: shutdown_drain', () => {
      const res = mockResponse();
      const outcome = handleArgonError(res, new ShuttingDownError());

      expect(outcome).toBe('handled');
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.set).toHaveBeenCalledWith('Retry-After', String(SHUTDOWN_RETRY_AFTER_SEC));
      expect(res.set).toHaveBeenCalledWith('Retry-After', '30');
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: SERVICE_UNAVAILABLE_MESSAGE,
          details: { reason: ARGON_REASON_SHUTDOWN_DRAIN },
        },
      });
      // Sentinel pin matching the queue-full case; the wire literal is the
      // contract canaries match against and must not silently drift.
      expect(ARGON_REASON_SHUTDOWN_DRAIN).toBe('shutdown_drain');
      // Body string MUST NOT mention "shutting down" or "shutdown"; that
      // was the deployment-state leak the genericize task closed.
      expect(SERVICE_UNAVAILABLE_MESSAGE).not.toMatch(/shut\s?down/i);
    });

    it('logs info-level on the shutdown branch (operators triage differently from queue-full)', () => {
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as unknown as void);
      const res = mockResponse();
      const err = new ShuttingDownError();

      handleArgonError(res, err, { logContext: { username: 'bob' } });

      expect(infoSpy).toHaveBeenCalledWith(
        { err, username: 'bob' },
        'argon2 semaphore shutting down — returning 503',
      );
    });

    it('honors opts.retryAfterSec override on shutdown branch', () => {
      const res = mockResponse();
      handleArgonError(res, new ShuttingDownError(), { retryAfterSec: 90 });

      expect(res.set).toHaveBeenCalledWith('Retry-After', '90');
      expect(res.set).not.toHaveBeenCalledWith('Retry-After', '30');
    });
  });

  describe('ArgonAbortError → silent handled (no body, no Retry-After)', () => {
    it('returns handled without writing status, json, or Retry-After', () => {
      const res = mockResponse();
      const outcome = handleArgonError(res, new ArgonAbortError());

      expect(outcome).toBe('handled');
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(res.set).not.toHaveBeenCalled();
    });

    it('ignores opts.retryAfterSec on abort branch (no header — socket is gone)', () => {
      const res = mockResponse();
      handleArgonError(res, new ArgonAbortError(), { retryAfterSec: 99 });

      expect(res.set).not.toHaveBeenCalled();
    });
  });

  describe('opts.retryAfterSec validation (perimeter check)', () => {
    // Invalid overrides MUST fall back to the per-branch default so a
    // future caller deriving the value from user input cannot land a
    // malformed `Retry-After` on the wire (NaN/Infinity/negative/non-finite
    // serialize inconsistently across proxies and clients). The fallback
    // path also emits a `logger.warn` so the misuse is loud at runtime.
    type InvalidCase = [label: string, value: number];
    const invalidCases: InvalidCase[] = [
      ['negative', -5],
      ['NaN', Number.NaN],
      ['positive Infinity', Number.POSITIVE_INFINITY],
      ['negative Infinity', Number.NEGATIVE_INFINITY],
    ];

    describe('queue-full branch', () => {
      it.each(invalidCases)(
        'falls back to QUEUE_FULL_RETRY_AFTER_SEC and warns when retryAfterSec is %s',
        (_label, value) => {
          const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
          const res = mockResponse();
          handleArgonError(res, new ArgonQueueFullError(), { retryAfterSec: value });

          expect(res.set).toHaveBeenCalledWith('Retry-After', String(QUEUE_FULL_RETRY_AFTER_SEC));
          expect(warnSpy).toHaveBeenCalledWith(
            { retryAfterSec: value, defaultSec: QUEUE_FULL_RETRY_AFTER_SEC },
            'argon2 handler: ignoring invalid retryAfterSec override; falling back to branch default',
          );
        },
      );

      it('floors fractional retryAfterSec to an integer (no malformed header)', () => {
        const res = mockResponse();
        handleArgonError(res, new ArgonQueueFullError(), { retryAfterSec: 7.9 });

        expect(res.set).toHaveBeenCalledWith('Retry-After', '7');
        expect(res.set).not.toHaveBeenCalledWith('Retry-After', '7.9');
      });

      it('accepts zero as a valid override (HTTP allows Retry-After: 0)', () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
        const res = mockResponse();
        handleArgonError(res, new ArgonQueueFullError(), { retryAfterSec: 0 });

        expect(res.set).toHaveBeenCalledWith('Retry-After', '0');
        // No warn — zero is valid.
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.objectContaining({ retryAfterSec: 0 }),
          expect.anything(),
        );
      });
    });

    describe('shutdown branch', () => {
      it.each(invalidCases)(
        'falls back to SHUTDOWN_RETRY_AFTER_SEC and warns when retryAfterSec is %s',
        (_label, value) => {
          const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
          const res = mockResponse();
          handleArgonError(res, new ShuttingDownError(), { retryAfterSec: value });

          expect(res.set).toHaveBeenCalledWith('Retry-After', String(SHUTDOWN_RETRY_AFTER_SEC));
          expect(warnSpy).toHaveBeenCalledWith(
            { retryAfterSec: value, defaultSec: SHUTDOWN_RETRY_AFTER_SEC },
            'argon2 handler: ignoring invalid retryAfterSec override; falling back to branch default',
          );
        },
      );

      it('floors fractional retryAfterSec to an integer (no malformed header)', () => {
        const res = mockResponse();
        handleArgonError(res, new ShuttingDownError(), { retryAfterSec: 12.5 });

        expect(res.set).toHaveBeenCalledWith('Retry-After', '12');
        expect(res.set).not.toHaveBeenCalledWith('Retry-After', '12.5');
      });

      it('accepts zero as a valid override (HTTP allows Retry-After: 0)', () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);
        const res = mockResponse();
        handleArgonError(res, new ShuttingDownError(), { retryAfterSec: 0 });

        expect(res.set).toHaveBeenCalledWith('Retry-After', '0');
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.objectContaining({ retryAfterSec: 0 }),
          expect.anything(),
        );
      });
    });
  });

  describe('non-semaphore errors → unhandled', () => {
    it('returns unhandled for a plain Error and writes nothing', () => {
      const res = mockResponse();
      const outcome = handleArgonError(res, new Error('boom'));

      expect(outcome).toBe('unhandled');
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(res.set).not.toHaveBeenCalled();
    });

    it('returns unhandled for a thrown string and writes nothing', () => {
      const res = mockResponse();
      const outcome = handleArgonError(res, 'not even an error');

      expect(outcome).toBe('unhandled');
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});

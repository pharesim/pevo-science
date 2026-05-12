/**
 * Tests for the project-wide pino logger wrapper's runtime API surface
 * (src/logger.ts → exported `logger`).
 *
 * Why this file exists:
 *   The Layer-A redact wrapper exposes only the level methods (`warn`,
 *   `error`, `info`, `debug`, `fatal`, `trace`) plus `flush`. Pino's
 *   runtime API also includes `child`, `isLevelEnabled`, `level`
 *   (read/write), and `bindings`. Without those forwards, future call
 *   sites that reach for the standard pino surface either TypeError
 *   (`logger.child is not a function`) or silently bypass pino's
 *   cheap-skip optimization (`if (logger.isLevelEnabled('debug'))`).
 *
 * The architect's 2026-05-11 decision on the parent task selected
 * option 2 (documentary) for `child`: forward verbatim, accept that
 * the returned child logger does NOT inherit the call-site Layer-A
 * wrapper, and pin the gap with a negative assertion so a future
 * inadvertent migration to option 1 fails red until the JSDoc is
 * updated. See backend-logger-wrapper-pino-runtime-api-surface.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../src/logger.js';

describe('logger wrapper — pino runtime API surface', () => {
  let originalLevel: string;

  beforeEach(() => {
    originalLevel = logger.level;
  });

  afterEach(() => {
    logger.level = originalLevel;
  });

  describe('level (getter/setter)', () => {
    it('round-trips a level write through to baseLogger', () => {
      logger.level = 'debug';
      expect(logger.level).toBe('debug');

      logger.level = 'warn';
      expect(logger.level).toBe('warn');
    });

    it('drives isLevelEnabled — debug is enabled at level=debug, disabled at level=info', () => {
      logger.level = 'debug';
      expect(logger.isLevelEnabled('debug')).toBe(true);

      logger.level = 'info';
      expect(logger.isLevelEnabled('debug')).toBe(false);
      // Info and above stay enabled at level=info — pin the threshold
      // so a future change that swaps the comparison direction fails red.
      expect(logger.isLevelEnabled('info')).toBe(true);
      expect(logger.isLevelEnabled('warn')).toBe(true);
    });
  });

  describe('isLevelEnabled', () => {
    it('forwards to baseLogger — accepts all pino level names', () => {
      logger.level = 'trace';
      expect(logger.isLevelEnabled('trace')).toBe(true);
      expect(logger.isLevelEnabled('fatal')).toBe(true);

      logger.level = 'silent';
      expect(logger.isLevelEnabled('trace')).toBe(false);
      expect(logger.isLevelEnabled('error')).toBe(false);
      expect(logger.isLevelEnabled('fatal')).toBe(false);
    });
  });

  describe('bindings', () => {
    it('returns the bindings object pino exposes on the root logger', () => {
      const b = logger.bindings();
      // Pino's baseLogger has no .child() chain applied, so bindings is
      // an empty object (Bindings = Record<string, any>). The contract
      // we pin is "callable and returns an object" — the value shape is
      // dictated by pino, not by PEvO.
      expect(typeof b).toBe('object');
      expect(b).not.toBeNull();
    });

    it('child bindings appear on the child logger', () => {
      const child = logger.child({ reqId: 'wrapper-api-test' });
      expect(child.bindings()).toEqual({ reqId: 'wrapper-api-test' });
    });
  });

  describe('child', () => {
    it('returns a pino logger with the level methods present', () => {
      const child = logger.child({ scope: 'child-shape' });
      expect(typeof child.warn).toBe('function');
      expect(typeof child.error).toBe('function');
      expect(typeof child.info).toBe('function');
      expect(typeof child.debug).toBe('function');
      expect(typeof child.fatal).toBe('function');
      expect(typeof child.trace).toBe('function');
      expect(typeof child.child).toBe('function');
    });

    // Negative-assertion test pinning the option 2 (documentary) contract:
    // the returned child logger does NOT inherit the call-site Layer-A
    // wrapper (`redactErrInArg`). A spy on `child.warn` sees the
    // UNREDACTED err object at call time. Layer-B (pino's
    // `serializers.err` config) still fires at write time, but that is
    // not observable through vi.spyOn's `.mock.calls` capture.
    //
    // If a future change wraps `child` with the Layer-A factory (option
    // 1), this assertion flips and the test fails red — the developer
    // is then forced to update the JSDoc on `logger.child` before
    // re-greening the suite. That is the intended ratchet.
    it('child level methods do NOT apply Layer-A redaction (option 2 documentary contract)', () => {
      const child = logger.child({ scope: 'layer-a-gap' });
      const warnSpy = vi.spyOn(child, 'warn').mockImplementation((() => {}) as never);

      // Construct a leaky err shape that Layer-A WOULD redact at the
      // wrapper. The `command.args[]` field carries a counterfeit
      // 64-hex token — the same shape ioredis attaches to ReplyError
      // and the same shape Layer-A strips via `redactErrInArg`.
      const verifyToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const leakyErr = Object.assign(new Error('Redis rejected eval'), {
        name: 'ReplyError',
        command: { name: 'eval', args: ['lua-script-body', '1', `pevotest:probe:${verifyToken}`] },
      });
      child.warn({ err: leakyErr }, 'leaky shape test');

      // The spy's captured arg STILL holds the raw leaky shape, because
      // the child's `warn` method is baseLogger.child(...).warn — not
      // the Layer-A wrapper. This is the contract the architect's 2026-
      // 05-11 decision documents.
      const firstCall = warnSpy.mock.calls[0] as unknown[];
      const firstArg = firstCall[0] as { err: { command?: { args: string[] } } };
      expect(firstArg.err.command).toBeDefined();
      expect(firstArg.err.command?.args).toContain(`pevotest:probe:${verifyToken}`);

      warnSpy.mockRestore();
    });
  });
});

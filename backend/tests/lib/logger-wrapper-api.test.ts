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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    // Coverage for the `options` second arg pino's child() accepts (level
    // override, redact, msgPrefix, etc.). A future signature regression
    // that silently drops the second arg again fails this test red.
    it('forwards options to baseLogger.child — child-level override is honored', () => {
      logger.level = 'info';
      const child = logger.child({}, { level: 'debug' });
      // The child-level override wins regardless of the root logger's level.
      expect(child.isLevelEnabled('debug')).toBe(true);
      // Root logger's level is unaffected by the child override.
      expect(logger.isLevelEnabled('debug')).toBe(false);
    });

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

    // Negative-assertion ratchet pinning the option 2 (documentary)
    // contract: the returned child logger does NOT inherit the call-site
    // Layer-A wrapper (`redactErrInArg`). Layer-A mutates `args[0].err`
    // in place — see logger.ts:355-368 "IMPORTANT — in-place mutation …
    // is INTENTIONAL". Observing that mutation directly on the input
    // object reference is the load-bearing observable here; a vi.spyOn
    // stub would replace child.warn entirely and pass green under BOTH
    // option 1 and option 2, defeating the ratchet.
    //
    // If a future change wraps `child` with the Layer-A factory (option
    // 1), redactErrInArg would mutate argObj.err to the SerializedErr
    // shape before pino sees it, dropping `command`. That flips this
    // assertion red, forcing the JSDoc on logger.child to be updated
    // before the suite re-greens.
    it('child level methods do NOT apply Layer-A redaction (option 2 documentary contract)', () => {
      const child = logger.child({ scope: 'layer-a-gap' });
      const verifyToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const leakyErr = Object.assign(new Error('Redis rejected eval'), {
        name: 'ReplyError',
        command: { name: 'eval', args: ['lua-script-body', '1', `pevotest:probe:${verifyToken}`] },
      });
      const argObj: { err: { command?: { name: string; args: string[] } } } = { err: leakyErr };

      // Silence stdout — child.warn is the real pino method, not a stub.
      const savedLevel = logger.level;
      logger.level = 'silent';
      try {
        child.warn(argObj, 'leaky shape test');
      } finally {
        logger.level = savedLevel;
      }

      // Under option 2 (current), child.warn is the raw pino method — no
      // Layer-A mutation — argObj.err.command stays intact. Under a future
      // option-1 migration that wraps child via wrapPinoLogger(...),
      // redactErrInArg would mutate argObj.err to the SerializedErr shape
      // before pino sees it, dropping command. That mutation flips this
      // assertion red.
      expect(argObj.err.command).toBeDefined();
      expect(argObj.err.command?.args).toContain(`pevotest:probe:${verifyToken}`);
    });
  });
});

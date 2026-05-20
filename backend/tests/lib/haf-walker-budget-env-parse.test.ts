import { describe, it, expect } from 'vitest';
import { parseHafWalkerBudget } from '../../src/config.js';

// Pins the parse formula for HAF_WALKER_WALL_CLOCK_MS. The integration tests
// in tests/routes/canonical-root-walker.test.ts and tests/routes/continuation-
// author-gate.test.ts override `config.hafWalkerWallClockMs` directly via
// a `(config as { hafWalkerWallClockMs: number })` cast, bypassing this
// parse path entirely — so without this file the invariants below (NaN
// guard, zero/negative guard, no `parseInt` truncation) have zero coverage.
//
// The `> 0` floor is load-bearing: `setTimeout(fn, 0)` and `setTimeout(fn,
// NaN)` both coerce to immediate-fire per ECMAScript spec. A regression
// that lets `'0'`, `'-1'`, or `'disabled'` through would fire the wall-
// clock abort on every paper-detail request and surface a retriable 503
// to every client.
describe('parseHafWalkerBudget', () => {
  it('returns 3000 fallback when env is undefined (unset)', () => {
    expect(parseHafWalkerBudget(undefined)).toBe(3000);
  });

  it('returns 3000 fallback when env is empty string', () => {
    // Number('') === 0; the `> 0` check rejects, fallback fires.
    expect(parseHafWalkerBudget('')).toBe(3000);
  });

  it('returns 3000 fallback when env is non-numeric (e.g. "disabled")', () => {
    // Number('disabled') === NaN; Number.isFinite(NaN) === false.
    expect(parseHafWalkerBudget('disabled')).toBe(3000);
  });

  it('returns 3000 fallback when env is literal "0"', () => {
    // Without the `> 0` floor, setTimeout(fn, 0) fires on the next tick —
    // every request emits wall-clock-exceeded.
    expect(parseHafWalkerBudget('0')).toBe(3000);
  });

  it('returns 3000 fallback when env is negative ("-1")', () => {
    // setTimeout coerces negative delays to 0 per ECMAScript; same
    // immediate-fire hazard as literal-0.
    expect(parseHafWalkerBudget('-1')).toBe(3000);
  });

  it('returns 5000 when env is "5000"', () => {
    expect(parseHafWalkerBudget('5000')).toBe(5000);
  });

  it('returns 3000 fallback when env carries unit suffix ("3000ms")', () => {
    // Number('3000ms') === NaN — pre-fix `parseInt(..., 10)` swallowed the
    // numeric prefix and returned 3000, masking the operator's
    // misconfiguration. The new helper rejects so the fallback default is
    // explicit and operators see the misconfig via the gap between the
    // env value and the runtime config.
    expect(parseHafWalkerBudget('3000ms')).toBe(3000);
  });

  it('returns 1000 for scientific notation "1e3" (Number, not parseInt → 1)', () => {
    // parseInt('1e3', 10) === 1 (stops at 'e'); Number('1e3') === 1000.
    // Pins the parseInt → Number migration: a regression reverting the
    // helper would silently yield 1ms, immediate-fire on every request.
    expect(parseHafWalkerBudget('1e3')).toBe(1000);
  });

  it('returns 1.5 for fractional ms "1.5" (Number, not parseInt → 1)', () => {
    // parseInt('1.5', 10) === 1; Number('1.5') === 1.5. Same regression
    // class as '1e3' — pins the helper against silent truncation.
    expect(parseHafWalkerBudget('1.5')).toBe(1.5);
  });
});

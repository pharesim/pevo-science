/**
 * Tests for the project-wide pino `err` serializer redact policy
 * (src/logger.ts → `redactErrSerializer`).
 *
 * Why this file exists:
 *   pino's default err serializer enumerates ALL enumerable own properties
 *   of an error object and copies them to the serialized payload. This has
 *   produced two concrete leak surfaces in PEvO:
 *
 *     (1) AssertionError.actual / .expected (Buffer slices DERIVED from a
 *         WIF private key) reach operator logs when dhive's
 *         PrivateKey.fromString rejects malformed input. An attacker with
 *         read access to the log stream can reconstruct the bridge admin
 *         posting key.
 *
 *     (2) ReplyError.command = { name, args } (ioredis shape) reaches
 *         operator logs when a command call rejects. For redis.eval of
 *         the accreditation broadcast-attempts INCR script, args[]
 *         contains the raw 64-hex verify token — the SOLE credential at
 *         /api/accreditation/verify.
 *
 * Mutation-kill assertions:
 *   Removing the redact policy from src/logger.ts (reverting to pino's
 *   default err serializer) MUST cause every assertion in this file to
 *   fail red. Each test is structured so the absence of redaction is the
 *   load-bearing signal — a passing test confirms the redactor is active,
 *   not just that the error happened to lack the leaky field.
 *
 * Cross-references:
 *   α (BACKEND-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION) — AssertionError leak
 *   δ (BE-VERIFY-BROADCAST-ATTEMPTS-CAP) — ReplyError.command leak
 *   src/lib/log-pii.ts — per-field hash helpers; redact policy is the
 *     project-wide complement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { redactErrSerializer, logger } from '../../src/logger.js';

describe('redactErrSerializer — pino err serializer redact policy', () => {
  it('AssertionError: strips .actual and .expected (Buffer slices derived from WIF)', () => {
    // Reconstruct the AssertionError shape that dhive's PrivateKey.fromString
    // throws on a malformed WIF: the `actual` and `expected` properties carry
    // Buffer slices DERIVED from the WIF (with the network-ID byte and 4-byte
    // checksum). Default pino err serializer would copy them verbatim.
    const actualBuf = Buffer.from('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex');
    const expectedBuf = Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'hex');
    const err = Object.assign(new Error('Expected values to be strictly deep-equal'), {
      name: 'AssertionError',
      actual: actualBuf,
      expected: expectedBuf,
      operator: 'deepStrictEqual',
    });
    const out = redactErrSerializer(err) as Record<string, unknown>;

    // The leaky fields must be absent.
    expect(out.actual).toBeUndefined();
    expect(out.expected).toBeUndefined();
    expect(out.operator).toBeUndefined();

    // Belt-and-suspenders: the serialized JSON does NOT contain either
    // hex pattern. This is the assertion that fires red if a future change
    // re-adds the field via a different path (e.g., toJSON, custom getter).
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(serialized).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Baseline survives.
    expect(out.message).toBe('Expected values to be strictly deep-equal');
    expect(out.type).toBe('Error');
    expect(typeof out.stack).toBe('string');
  });

  it('ioredis ReplyError: strips .command (and .command.args containing 64-hex token)', () => {
    // The δ leak surface: ioredis attaches err.command = { name, args } to
    // any error propagated from a command call. For redis.eval of the
    // accreditation broadcast-attempts INCR script, args[] includes the
    // key `${appTag}:pending_accred_broadcast_attempts:${token}` where
    // ${token} is the raw 64-hex verify token — the SOLE credential at
    // /api/accreditation/verify.
    const verifyToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const counterKey = `pevotest:pending_accred_broadcast_attempts:${verifyToken}`;
    const err = Object.assign(new Error('Redis evicted to read-only'), {
      name: 'ReplyError',
      command: {
        name: 'eval',
        args: [
          "local count = redis.call('INCR', KEYS[1])\nif count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end\nreturn count",
          '1',
          counterKey,
          '86400',
        ],
      },
    });
    const out = redactErrSerializer(err) as Record<string, unknown>;

    // The leaky field must be absent.
    expect(out.command).toBeUndefined();

    // Load-bearing negative regex: the raw 64-hex token is NOT in the
    // serialized payload. This is the assertion the existing
    // accreditation.test.ts redaction test was supposed to enforce but
    // passed by construction (see δ round-3 hold #1).
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toContain(verifyToken);
    expect(serialized).not.toContain(counterKey);

    // Baseline survives.
    expect(out.message).toBe('Redis evicted to read-only');
  });

  it('VError-shaped error: strips .info, .jse_info, .jse_shortmsg, .jse_cause', () => {
    // VError / dhive RPC errors hang chain-internal payloads off non-standard
    // properties. Strip them all — operators have err.message, the
    // structured logContext at the call site, and the route's own audit
    // events for triage; they don't need raw RPC payload bytes.
    const err = Object.assign(new Error('RPC node rejected operation'), {
      name: 'VError',
      info: { signed_op: 'custom_json:secret_payload_bytes', signing_account: 'pevo.bridge' },
      jse_info: { internal_hint: 'sensitive_diagnostic' },
      jse_shortmsg: 'short-msg-with-internal-detail',
      jse_cause: { node_response: 'internal_node_state_dump' },
    });
    const out = redactErrSerializer(err) as Record<string, unknown>;

    expect(out.info).toBeUndefined();
    expect(out.jse_info).toBeUndefined();
    expect(out.jse_shortmsg).toBeUndefined();
    expect(out.jse_cause).toBeUndefined();

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('secret_payload_bytes');
    expect(serialized).not.toContain('sensitive_diagnostic');
    expect(serialized).not.toContain('internal_node_state_dump');
    expect(serialized).not.toContain('short-msg-with-internal-detail');

    expect(out.message).toBe('RPC node rejected operation');
  });

  it('plain Error: name, message, stack survive intact', () => {
    const err = new Error('Plain operational error');
    const out = redactErrSerializer(err) as Record<string, unknown>;

    expect(out.message).toBe('Plain operational error');
    expect(out.type).toBe('Error');
    expect(typeof out.stack).toBe('string');
    expect((out.stack as string).length).toBeGreaterThan(10);
  });

  it('Error with cause chain: cause is recursively serialized AND the recursion passes through the redact policy', () => {
    // Wrap an AssertionError as a cause. The default pino serializer (or a
    // naive recursion) would expand the inner error's `actual`/`expected`
    // through the `cause` link. The redactor must apply the same policy at
    // every cause depth.
    const innerActual = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex');
    const innerErr = Object.assign(new Error('inner assertion failed'), {
      name: 'AssertionError',
      actual: innerActual,
      expected: Buffer.from('cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe', 'hex'),
      operator: 'deepStrictEqual',
    });
    const outerErr = new Error('outer wrapper');
    Object.assign(outerErr, { cause: innerErr });

    const out = redactErrSerializer(outerErr) as Record<string, unknown>;

    expect(out.message).toBe('outer wrapper');
    expect(out.cause).toBeDefined();
    const cause = out.cause as Record<string, unknown>;

    // Cause survived the recursion.
    expect(cause.message).toBe('inner assertion failed');
    // But its leaky fields were stripped.
    expect(cause.actual).toBeUndefined();
    expect(cause.expected).toBeUndefined();
    expect(cause.operator).toBeUndefined();

    // Belt-and-suspenders: serialized output does not contain either Buffer's
    // hex bytes. This is the recursion-correctness signal.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(serialized).not.toContain('cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe');
  });

  it('cause chain: a ReplyError nested as cause has its command.args stripped', () => {
    // The cross-cluster scenario: a route catches an ioredis error, wraps
    // it in a domain error, and logs the wrapper. The wrapper's `cause`
    // link reaches the original ReplyError. Without recursive redaction,
    // the wrapped form would still leak the 64-hex token.
    const verifyToken = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const replyErr = Object.assign(new Error('NOSCRIPT'), {
      name: 'ReplyError',
      command: { name: 'evalsha', args: ['abcd1234', '1', `pevotest:x:${verifyToken}`] },
    });
    const wrapper = new Error('Broadcast cleanup failed');
    Object.assign(wrapper, { cause: replyErr });

    const out = redactErrSerializer(wrapper) as Record<string, unknown>;
    const cause = out.cause as Record<string, unknown>;
    expect(cause.command).toBeUndefined();

    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toContain(verifyToken);
  });

  it('preserves operational allowlist fields (code, errno, syscall) for ENOENT-style triage', () => {
    // Operators rely on `code` for ENOENT/ETIMEDOUT/ECONNREFUSED
    // classification. Stripping them would harm triage with no privacy gain.
    const err = Object.assign(new Error('ENOENT: no such file'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
    });
    const out = redactErrSerializer(err) as Record<string, unknown>;
    expect(out.code).toBe('ENOENT');
    expect(out.errno).toBe(-2);
    expect(out.syscall).toBe('open');
  });

  it('non-Error inputs pass through unchanged (pino can string-coerce them itself)', () => {
    expect(redactErrSerializer('a string')).toBe('a string');
    expect(redactErrSerializer(42)).toBe(42);
    expect(redactErrSerializer(null)).toBeNull();
    expect(redactErrSerializer(undefined)).toBeUndefined();
    // Plain object without name/message: not error-like, passes through.
    const plain = { foo: 'bar' };
    expect(redactErrSerializer(plain)).toBe(plain);
  });

  it('strips an unknown leaky field via the allowlist (not a denylist)', () => {
    // Mutation-kill against a denylist refactor: the redactor uses an
    // explicit allowlist (`SAFE_BASELINE_FIELDS`) to copy fields, so a
    // novel leaky field on a future error subclass is excluded by default.
    // If a refactor flipped to a denylist, this test would fail red.
    const err = Object.assign(new Error('Some error'), {
      // Pretend a future error subclass adds a `secret_payload` field.
      secret_payload: 'this-must-not-leak',
      another_leak: { nested: 'sensitive_inner' },
    });
    const out = redactErrSerializer(err) as Record<string, unknown>;
    expect(out.secret_payload).toBeUndefined();
    expect(out.another_leak).toBeUndefined();

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('this-must-not-leak');
    expect(serialized).not.toContain('sensitive_inner');
  });

  it('aggregateErrors: serializes via the same redactor (each member loses leaky fields)', () => {
    // Node 15+ AggregateError or pino-style err.errors arrays should
    // recurse through the redactor.
    const inner1 = Object.assign(new Error('inner-1'), {
      name: 'ReplyError',
      command: { name: 'get', args: ['pevotest:secret-key-name'] },
    });
    const inner2 = Object.assign(new Error('inner-2'), {
      name: 'AssertionError',
      actual: Buffer.from('1111111111111111111111111111111111111111111111111111111111111111', 'hex'),
    });
    const agg = Object.assign(new Error('aggregate-wrapper'), {
      errors: [inner1, inner2],
    });
    const out = redactErrSerializer(agg) as Record<string, unknown>;
    expect(Array.isArray(out.aggregateErrors)).toBe(true);
    const arr = out.aggregateErrors as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr[0].command).toBeUndefined();
    expect(arr[1].actual).toBeUndefined();

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('pevotest:secret-key-name');
    expect(serialized).not.toContain('1111111111111111111111111111111111111111111111111111111111111111');
  });

  it('subclass type: reports err.constructor.name correctly (TypeError, RangeError)', () => {
    // The serializer should preserve the error subclass identity in the
    // `type` field so operators can still group by error class even
    // without the leaky fields.
    expect((redactErrSerializer(new TypeError('bad type')) as Record<string, unknown>).type).toBe('TypeError');
    expect((redactErrSerializer(new RangeError('out of range')) as Record<string, unknown>).type).toBe('RangeError');
  });

  // ───────────────────────────────────────────────────────────────────
  // Round-3 hold #10 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
  // preserve-recursion through cause is well-covered (above). The dual is
  // unmocked: do the SAFE_BASELINE_FIELDS (`code`, `errno`, `syscall`)
  // survive at every level of a nested cause chain? An adversarial
  // refactor that "simplified" the cause-recursion to skip baseline-field
  // copying at depth > 0 would still pass the existing strip-recursion
  // tests but would silently lose ENOENT/ECONNREFUSED triage data on
  // wrapped errors. Pin the preserve invariant.
  // ───────────────────────────────────────────────────────────────────
  it('cause chain: code/errno/syscall preservation survives through cause recursion (round-3 hold #10)', () => {
    const inner = Object.assign(new Error('econnrefused'), {
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
    });
    const outer = new Error('outer wrapper for connection error');
    Object.assign(outer, { cause: inner });

    const out = redactErrSerializer(outer) as Record<string, unknown>;
    expect(out.cause).toBeDefined();
    const cause = out.cause as Record<string, unknown>;
    expect(cause.code).toBe('ECONNREFUSED');
    expect(cause.errno).toBe(-111);
    expect(cause.syscall).toBe('connect');
    // The outer (which has no code/errno/syscall) should not have them
    // either — they belong to the cause, not the outer.
    expect(out.code).toBeUndefined();
    expect(out.errno).toBeUndefined();
    expect(out.syscall).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────
  // Round-3 hold #3 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
  // depth/cycle guard. The pre-round-3 self-reference guard caught only
  // depth-1 cycles (`A.cause = A`); a 2-step cycle (`A.cause = B; B.cause
  // = A`) or an unbounded chain would stack-overflow and crash. Mutation
  // kill: removing `if (depth > MAX_CAUSE_DEPTH) return sentinel` would
  // either crash (cycle) or recurse to an absurd depth (unbounded chain).
  // ───────────────────────────────────────────────────────────────────
  it('depth/cycle guard: a 2-step cause cycle does NOT crash and surfaces a MaxDepthExceeded sentinel (round-3 hold #3)', () => {
    // Construct A.cause = B; B.cause = A. Without the depth guard this
    // would recurse forever.
    const a = new Error('A — outer');
    const b = new Error('B — inner');
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });

    // Must not throw / crash. Returns finite output.
    const out = redactErrSerializer(a) as Record<string, unknown>;
    expect(out).toBeDefined();
    // Walk the cause chain looking for the sentinel. After 11 levels,
    // the recursion bails. Each level is its own redacted err object;
    // the sentinel surfaces somewhere in the chain.
    let cur: Record<string, unknown> = out;
    let depth = 0;
    while (cur.cause && depth < 30) {
      cur = cur.cause as Record<string, unknown>;
      if (cur.type === 'MaxDepthExceeded') break;
      depth += 1;
    }
    expect(cur.type).toBe('MaxDepthExceeded');
    expect(typeof cur.depth).toBe('number');
  });

  it('depth guard: an unbounded linear cause chain truncates at MaxDepthExceeded (round-3 hold #3)', () => {
    // Build a 50-deep linear chain; without the guard this would still
    // serialize (not crash) but would produce a 50-deep nested payload
    // that would explode log volumes. The guard caps at 11 levels.
    let head: Error & { cause?: Error } = new Error('leaf') as Error & { cause?: Error };
    for (let i = 0; i < 50; i += 1) {
      const wrapper = new Error(`layer-${i}`) as Error & { cause?: Error };
      wrapper.cause = head;
      head = wrapper;
    }
    const out = redactErrSerializer(head) as Record<string, unknown>;
    // Walk down the cause chain counting levels.
    let cur: Record<string, unknown> = out;
    let depth = 0;
    while (cur.cause && depth < 60) {
      cur = cur.cause as Record<string, unknown>;
      if (cur.type === 'MaxDepthExceeded') break;
      depth += 1;
    }
    expect(cur.type).toBe('MaxDepthExceeded');
    // Sanity: the truncation kicked in well before 50.
    expect(depth).toBeLessThan(50);
  });

  // ───────────────────────────────────────────────────────────────────
  // Round-3 hold #4 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
  // try/catch fallback when `redactErrSerializer` itself throws on a
  // hostile err shape. Mutation kill: removing the try/catch wrapper
  // around the serializer call would cause this test to throw out of the
  // `safeRedactErr` invocation and fail the test (or, in the wrapper-
  // layer test below, propagate the throw out of `logger.warn(...)`).
  // ───────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────
  // Round-4 hold #2 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
  // plain-object cause leak canary. `redactErrSerializer`'s entry guard
  // (`if (!isErrorLike(err)) return err`) is correct for the top-level
  // entry (pino can string-coerce non-Error inputs), but at the recursive
  // cause layer it short-circuits: a future cause shape like
  //   `Object.assign(new Error('outer'), { cause: { command: { args: [...] } } })`
  // hits `isErrorLike(plainObj) === false` on the recursive call and
  // returns the object verbatim — bypassing the SAFE_BASELINE_FIELDS
  // allowlist. Round-4 routes plain-object causes through `redactPlainObject`,
  // which applies the allowlist with NO short-circuit. Mutation kill:
  // reverting the `cause` recursion site to `redactErrSerializer(errAny.cause,
  // depth + 1)` (the pre-round-4 shape) makes this test fail because
  // `out.cause.command` is then the verbatim leaky shape.
  // ───────────────────────────────────────────────────────────────────
  it('plain-object cause: leaky fields stripped via redactPlainObject (round-4 hold #2)', () => {
    // The architect's exact reproducer fixture: an Error with a non-Error
    // `cause` carrying an ioredis-shaped command + args (the δ-flavored
    // leak surface, but smuggled through a plain-object cause).
    const verifyToken = 'cafe1234cafe1234cafe1234cafe1234cafe1234cafe1234cafe1234cafe1234';
    const outer = Object.assign(new Error('outer'), {
      cause: {
        command: { name: 'eval', args: ['some-lua', '1', `pevotest:x:${verifyToken}`] },
      },
    });

    const out = redactErrSerializer(outer) as Record<string, unknown>;

    // The outer Error's cause survives the recursion as a redacted shape,
    // not the verbatim plain object.
    expect(out.cause).toBeDefined();
    const cause = out.cause as Record<string, unknown>;

    // The leaky `command` field is absent from the redacted plain-object
    // cause. Pre-round-4 this would equal the verbatim
    // `{ name: 'eval', args: [...] }` object.
    expect(cause.command).toBeUndefined();

    // Belt-and-suspenders: the raw 64-hex token is NOT in the serialized
    // payload anywhere along the chain. Mutation-kill the regression at
    // the deepest level: a future refactor that "fixes" the type by passing
    // `errAny.cause as Error` to `redactErrSerializer` would silently fall
    // back to the entry pass-through and re-leak the token.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toContain(verifyToken);

    // The plain-object cause-redactor surfaces a recognizable `type` label
    // (`'Object'`) so dashboards can distinguish a plain-object cause from
    // an Error-shaped cause. (Aesthetic, but pinned so a regression that
    // drops the label doesn't go unnoticed.)
    expect(cause.type).toBe('Object');
  });

  it('plain-object cause: SAFE_BASELINE_FIELDS preserved through plain-object recursion (round-4 hold #2)', () => {
    // Defense-in-depth test for `redactPlainObject`: the allowlist is the
    // SAME `SAFE_BASELINE_FIELDS` used by the Error path. A regression that
    // forgets to copy `code`/`errno`/`syscall` on the plain-object branch
    // would silently lose ENOENT/ECONNREFUSED triage data on causes that
    // happen to be plain objects (e.g. a domain wrapper that hangs an
    // operational-context object off `cause`).
    const outer = Object.assign(new Error('outer connect-fail'), {
      cause: {
        code: 'ECONNREFUSED',
        errno: -111,
        syscall: 'connect',
        // Adversarial sibling that MUST NOT survive the allowlist.
        secret_payload: 'must-not-leak',
      },
    });

    const out = redactErrSerializer(outer) as Record<string, unknown>;
    const cause = out.cause as Record<string, unknown>;
    expect(cause.code).toBe('ECONNREFUSED');
    expect(cause.errno).toBe(-111);
    expect(cause.syscall).toBe('connect');
    expect(cause.secret_payload).toBeUndefined();

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('must-not-leak');
  });

  it('plain-object cause: depth guard bounds recursion through plain-object causes (round-4 hold #2 + round-3 hold #3)', () => {
    // Build a 50-deep plain-object cause chain. Without the depth guard
    // carrying through to `redactPlainObject`, this would still serialize
    // to a 50-deep payload and bloat log volumes; with the guard, it
    // truncates at MAX_CAUSE_DEPTH.
    let head: Record<string, unknown> = { code: 'leaf' };
    for (let i = 0; i < 50; i += 1) {
      head = { code: `layer-${i}`, cause: head };
    }
    const outer = Object.assign(new Error('outer'), { cause: head });

    const out = redactErrSerializer(outer) as Record<string, unknown>;
    let cur: Record<string, unknown> = out;
    let depth = 0;
    while (cur.cause && depth < 60) {
      cur = cur.cause as Record<string, unknown>;
      if (cur.type === 'MaxDepthExceeded') break;
      depth += 1;
    }
    expect(cur.type).toBe('MaxDepthExceeded');
    expect(depth).toBeLessThan(50);
  });

  // ───────────────────────────────────────────────────────────────────
  // Round-5 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
  // `errors[]` aggregate plain-object members previously bypassed redact at
  // `redactErrSerializer`'s map site. The `cause` recursion was hardened in
  // round-4 (`isErrorLike(cause) ? redactErrSerializer : redactPlainObject`)
  // but the symmetric `errors[]` map still routed every member through
  // `redactErrSerializer` directly, hitting the `isErrorLike === false`
  // short-circuit on plain-object members and returning them verbatim.
  // Mutation kill: reverting the map to `redactErrSerializer(e, depth + 1)`
  // makes `out.aggregateErrors[0].command` equal the verbatim leaky shape.
  // ───────────────────────────────────────────────────────────────────
  it('errors[] aggregate plain-object members route through redactPlainObject (round-5 hold #1)', () => {
    // The architect's exact reproducer: an Error with an aggregate `errors`
    // array carrying a plain-object member with an ioredis-shaped command.
    const verifyToken = 'feed1234feed1234feed1234feed1234feed1234feed1234feed1234feed1234';
    const outer = Object.assign(new Error('aggregate-outer'), {
      errors: [
        { command: { name: 'eval', args: ['some-lua', '1', `pevotest:x:${verifyToken}`] } },
      ],
    });

    const out = redactErrSerializer(outer) as Record<string, unknown>;
    expect(Array.isArray(out.aggregateErrors)).toBe(true);
    const arr = out.aggregateErrors as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(1);

    // The plain-object member's leaky `command` field is absent (routed
    // through `redactPlainObject` instead of returned verbatim).
    expect(arr[0].command).toBeUndefined();

    // Belt-and-suspenders: the raw 64-hex token is NOT in the serialized
    // payload anywhere in the aggregate.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toContain(verifyToken);

    // The plain-object redactor surfaces the recognizable `'Object'` type
    // label so dashboards can distinguish a plain-object aggregate member
    // from an Error-shaped one.
    expect(arr[0].type).toBe('Object');
  });

  // ───────────────────────────────────────────────────────────────────
  // Round-5 hold #2 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
  // an array-shaped `cause` (`isErrorLike([]) === false` ⇒ plain-object
  // dispatch ⇒ pre-round-5 array early-guard returned verbatim) leaked
  // every member's leaky fields. Round-5 replaces the array pass-through
  // in `redactPlainObject` with element-wise recursion. Mutation kill:
  // restoring the early `if (Array.isArray(value)) return value;` makes
  // every assertion below fail because the verbatim plain-object members
  // still carry `command.args`.
  // ───────────────────────────────────────────────────────────────────
  it('array cause: plain-object members recurse element-wise via redactPlainObject (round-5 hold #2)', () => {
    const verifyToken = 'beef1234beef1234beef1234beef1234beef1234beef1234beef1234beef1234';
    const outer = Object.assign(new Error('outer with array cause'), {
      cause: [
        { command: { name: 'eval', args: ['some-lua', '1', `pevotest:y:${verifyToken}`] } },
        { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', secret_payload: 'must-not-leak' },
      ],
    });

    const out = redactErrSerializer(outer) as Record<string, unknown>;
    expect(Array.isArray(out.cause)).toBe(true);
    const arr = out.cause as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);

    // Member 0 — leaky `command` stripped, `'Object'` label surfaces.
    expect(arr[0].command).toBeUndefined();
    expect(arr[0].type).toBe('Object');

    // Member 1 — SAFE_BASELINE_FIELDS preserved, adversarial sibling stripped.
    expect(arr[1].code).toBe('ECONNREFUSED');
    expect(arr[1].errno).toBe(-111);
    expect(arr[1].syscall).toBe('connect');
    expect(arr[1].secret_payload).toBeUndefined();

    // Belt-and-suspenders: serialized payload contains neither the raw token
    // nor the adversarial sibling string.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toContain(verifyToken);
    expect(serialized).not.toContain('must-not-leak');
  });

  it('try/catch fallback: a throwing-getter err yields the RedactSerializerFailed sentinel (round-3 hold #4)', () => {
    // Construct an err with a throwing `stack` getter. The serializer
    // reads `errAny.stack`, so this triggers the throw inside it. The
    // `safeRedactErr` wrapper around `redactErrSerializer` MUST catch it
    // and return the sentinel instead of letting it propagate.
    //
    // Direct call to the pure `redactErrSerializer` would re-raise (it has
    // no internal try/catch — that lives in `safeRedactErr`). The
    // serializer is private; we exercise it indirectly through the
    // wrapper-layer `logger.warn({err})` path that calls `safeRedactErr`
    // via `redactErrInArg`. Use `vi.spyOn` WITHOUT `mockImplementation` so
    // the real wrapper logic runs and mutates the err in place; the spy
    // captures the post-mutation reference.
    const hostileErr = new Error('hostile shape');
    Object.defineProperty(hostileErr, 'stack', {
      get() { throw new Error('stack-getter-throw'); },
      configurable: true,
    });

    const warnSpy = vi.spyOn(logger, 'warn');
    expect(() => logger.warn({ err: hostileErr }, 'should not throw')).not.toThrow();
    // The wrapper called `safeRedactErr`, which caught the throw and
    // produced the sentinel; the captured arg's `err` slot was mutated
    // to that sentinel.
    const captured = warnSpy.mock.calls[0][0] as { err: Record<string, unknown> };
    expect(captured.err.type).toBe('RedactSerializerFailed');
    expect(typeof captured.err.message).toBe('string');
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round-3 hold #8 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
// wrapper-layer mutation-kill canaries. The cases above test
// `redactErrSerializer` as a pure function. This block calls the public
// `logger.warn({err: ...})` surface and inspects what the spy captured —
// closing the spy-vs-serializer ordering trap mutation surface at the
// wrapper-layer level (locally, not via the distant accreditation tests).
//
// Reverting `redactErrInArg` to a no-op (or to a spread-copy that
// doesn't mutate the captured reference) MUST turn these red.
// ─────────────────────────────────────────────────────────────────────
describe('logger wrapper layer — call-site redaction (round-3 hold #8)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn');
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('logger.warn({err: ReplyError-shaped}) — spy sees redacted err (command stripped)', () => {
    const verifyToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const counterKey = `pevotest:pending_accred_broadcast_attempts:${verifyToken}`;
    const err = Object.assign(new Error('Redis evicted to read-only'), {
      name: 'ReplyError',
      command: { name: 'eval', args: ['some-lua', '1', counterKey, '86400'] },
    });

    logger.warn({ err, route: 'test.canary' }, 'a fake log line');

    // The wrapper mutates `err` in place on the SAME reference the spy
    // holds. Reverting `redactErrInArg` to a no-op makes this fail because
    // the spy captures the unmodified ReplyError shape with `command` intact.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const captured = warnSpy.mock.calls[0][0] as { err: Record<string, unknown> };
    // `command` (the leaky field) is gone after redaction.
    expect(captured.err.command).toBeUndefined();
    // Baseline survived.
    expect(captured.err.message).toBe('Redis evicted to read-only');
    expect(captured.err.type).toBe('Error');
    // Belt-and-suspenders: serialized payload contains no 64-hex run.
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toContain(verifyToken);
  });

  it('logger.warn({err: AssertionError-shaped}) — spy sees redacted err (actual/expected stripped)', () => {
    const err = Object.assign(new Error('Expected values to be strictly deep-equal'), {
      name: 'AssertionError',
      actual: Buffer.from('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex'),
      expected: Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'hex'),
      operator: 'deepStrictEqual',
    });

    logger.warn({ err, route: 'test.canary-2' }, 'fake log line 2');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const captured = warnSpy.mock.calls[0][0] as { err: Record<string, unknown> };
    expect(captured.err.actual).toBeUndefined();
    expect(captured.err.expected).toBeUndefined();
    expect(captured.err.operator).toBeUndefined();

    // Belt-and-suspenders: serialized payload contains neither hex string.
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(serialized).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('logger.warn(non-{err}-shaped object) — passes through unchanged', () => {
    // Mutation kill against a regression that broadens redaction beyond
    // the err slot. Sibling fields must NOT be touched.
    logger.warn({ route: 'test.canary-3', some: 'normal-field' }, 'a normal log line');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const captured = warnSpy.mock.calls[0][0] as { route: string; some: string; err?: unknown };
    expect(captured.route).toBe('test.canary-3');
    expect(captured.some).toBe('normal-field');
    expect(captured.err).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round-3 hold #7 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT):
// PINO_ERR_REDACT_LEVEL=relaxed branch coverage. `REDACT_LEVEL` is
// captured at module-load (logger.ts:79-80), so coverage requires a
// `vi.resetModules()` + `process.env.PINO_ERR_REDACT_LEVEL = 'relaxed'`
// + dynamic re-import. Mutation kill: removing the relaxed branch (or
// flipping the env-var name) would surface here as a relaxed-mode
// allowlist mismatch.
// ─────────────────────────────────────────────────────────────────────
describe('PINO_ERR_REDACT_LEVEL=relaxed branch coverage (round-3 hold #7)', () => {
  let originalLevel: string | undefined;
  beforeEach(() => {
    originalLevel = process.env.PINO_ERR_REDACT_LEVEL;
    vi.resetModules();
    process.env.PINO_ERR_REDACT_LEVEL = 'relaxed';
  });
  afterEach(() => {
    if (originalLevel === undefined) {
      delete process.env.PINO_ERR_REDACT_LEVEL;
    } else {
      process.env.PINO_ERR_REDACT_LEVEL = originalLevel;
    }
    vi.resetModules();
  });

  it('relaxed: preserves port/address/hostname/path on err', async () => {
    // Re-import after env-var change so the module-load capture re-reads.
    const { redactErrSerializer: redactRelaxed } = await import('../../src/logger.js');
    const err = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
      port: 5432,
      address: '10.0.0.5',
      hostname: 'pevo-postgres-1',
      path: '/var/run/postgres.sock',
    });
    const out = redactRelaxed(err) as Record<string, unknown>;
    expect(out.port).toBe(5432);
    expect(out.address).toBe('10.0.0.5');
    expect(out.hostname).toBe('pevo-postgres-1');
    expect(out.path).toBe('/var/run/postgres.sock');
    // Allowlist baseline still survives in relaxed mode.
    expect(out.code).toBe('ECONNREFUSED');
  });

  it('relaxed: known-leaky fields (command/args, actual/expected) STILL stripped', async () => {
    // Mutation kill against a regression that widened the relaxed
    // allowlist to include known-leaky fields. The relaxed mode is for
    // operational debugging; it must NOT bypass the security-driven
    // strip of `command`, `args`, `actual`, `expected`, etc.
    const { redactErrSerializer: redactRelaxed } = await import('../../src/logger.js');

    const replyErr = Object.assign(new Error('NOSCRIPT'), {
      name: 'ReplyError',
      command: { name: 'evalsha', args: ['abcd1234', '1', 'pevotest:secret-key-name'] },
    });
    const out1 = redactRelaxed(replyErr) as Record<string, unknown>;
    expect(out1.command).toBeUndefined();
    expect(JSON.stringify(out1)).not.toContain('pevotest:secret-key-name');

    const assertErr = Object.assign(new Error('Expected values to be deep-equal'), {
      name: 'AssertionError',
      actual: Buffer.from('1111111111111111111111111111111111111111111111111111111111111111', 'hex'),
      expected: Buffer.from('2222222222222222222222222222222222222222222222222222222222222222', 'hex'),
      operator: 'deepStrictEqual',
    });
    const out2 = redactRelaxed(assertErr) as Record<string, unknown>;
    expect(out2.actual).toBeUndefined();
    expect(out2.expected).toBeUndefined();
    expect(out2.operator).toBeUndefined();
  });
});

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

import { describe, it, expect } from 'vitest';
import { redactErrSerializer } from '../../src/logger.js';

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
});

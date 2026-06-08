/**
 * Signer-gate + value-sanitization coverage for `loadReputationWeights`
 * (`reputation.ts`). Two risk classes:
 *
 * 1. SIGNER GATE — an `update_weights` custom_json is honored only when its
 *    `required_posting_auths` carries `config.hiveAdminAccount`. Without the
 *    gate any Hive account could broadcast `{action:'update_weights',weights}`
 *    under the app's `custom_id` and seize every reputation parameter (custom_id
 *    + action are unauthenticated — any account can broadcast any custom_id).
 *    The gate `cj.required_posting_auths ? $2` (bound to the admin account) must
 *    appear on BOTH weights queries: the cheap existence probe AND the
 *    latest-op read. A removal from either re-opens the takeover.
 *
 * 2. VALUE SANITIZATION — even an admin-signed payload is untrusted operator
 *    input; `sanitizeReputationWeights` drops non-finite/non-numeric/unknown
 *    fields (fall back to defaults) and clamps domain-bounded fields so a
 *    downstream SQL consumer cannot receive an out-of-range multiplier.
 *
 * **Carve-out (per root CLAUDE.md "Running Tests"):** the signer-gate canary
 * mocks `getPool()` with a capturing pool that records the SQL/params
 * `loadReputationWeights` emits and returns canned rows, so the gate predicate
 * and bound param are asserted without HAF.
 *   (a) Real path impractical: asserting the signer-gate SQL shape against real
 *       HAF would require broadcasting/seeding a non-admin and an admin
 *       `update_weights` op on a live chain and is HAF-config-dependent; the
 *       canary must run even when HAF is unconfigured.
 *   (b) No auth/permission middleware in scope — this drives the loader helper
 *       directly; `verifyHiveSignature` does not run and is not the focus. The
 *       gate under test is a SQL `required_posting_auths` predicate, not request
 *       signature verification.
 *   (c) Real-path companion: the reputation lifecycle/batch suites run the daily
 *       cycle against real HAF, which calls `getReputationWeights` ->
 *       `loadReputationWeights` and executes the gated query against real
 *       Postgres. The risk class pinned HERE — the gate predicate's presence on
 *       BOTH queries and its bound admin param — is a removal/param-drift
 *       tripwire those integrated runs cannot catch (no malicious row exists to
 *       filter). The value-sanitization tests below are pure-function unit tests
 *       with no infrastructure at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../../src/config.js';
import { DEFAULT_REPUTATION_WEIGHTS } from '../../src/types/index.js';

const { getPoolMock } = vi.hoisted(() => ({ getPoolMock: vi.fn() }));

vi.mock('../../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db.js')>('../../src/db.js');
  return { ...actual, getPool: getPoolMock, isHafConfigured: () => getPoolMock() !== null };
});

const { loadReputationWeights, sanitizeReputationWeights } = await import('../../src/reputation.js');

type Captured = { sql: string; params: unknown[] | undefined };

// Capturing client: records every (sql, params) and returns canned rows that
// drive loadReputationWeights all the way through to the latest-op read so BOTH
// gated queries are emitted. The existence probe (LIKE prefilter) resolves
// non-empty so the function proceeds; the latest read returns a payload whose
// values exercise the sanitizer (paper override + an out-of-range decay_floor).
function makeCapturingPool(captured: Captured[]) {
  const client = {
    query: (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      if (typeof sql === 'string' && sql.includes("LIKE '%update_weights%'")) {
        return Promise.resolve({ rows: [{ exists: 1 }], rowCount: 1 });
      }
      if (typeof sql === 'string' && sql.includes("->> 'action'")) {
        return Promise.resolve({
          rows: [{ json: JSON.stringify({ action: 'update_weights', weights: { paper: 99, decay_floor: 1.5 } }) }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => undefined,
  };
  return { connect: async () => client };
}

afterEach(() => {
  getPoolMock.mockReset();
});

describe('loadReputationWeights — update_weights signer gate SQL shape', () => {
  it('gates BOTH the existence probe and the latest-op read on required_posting_auths bound to the admin account', async () => {
    const captured: Captured[] = [];
    getPoolMock.mockReturnValue(makeCapturingPool(captured) as unknown as ReturnType<typeof getPoolMock>);

    const weights = await loadReputationWeights();

    // The existence probe: text prefilter + signer gate.
    const probe = captured.find((c) => c.sql.includes("LIKE '%update_weights%'"));
    expect(probe, 'loadReputationWeights must emit the existence probe').toBeDefined();
    expect(probe!.sql).toMatch(/cj\.required_posting_auths \? \$2/);
    expect(probe!.params?.[1]).toBe(config.hiveAdminAccount);

    // The latest-op read: action filter + signer gate, newest-first.
    const latest = captured.find((c) => c.sql.includes("->> 'action'"));
    expect(latest, 'loadReputationWeights must emit the latest-op read').toBeDefined();
    expect(latest!.sql).toMatch(/cj\.required_posting_auths \? \$2/);
    expect(latest!.sql).toMatch(/ORDER BY cj\.block_num DESC/);
    expect(latest!.params?.[1]).toBe(config.hiveAdminAccount);

    // The admin-signed payload applies (paper override flows through) and its
    // out-of-range decay_floor is clamped by the sanitizer (1.5 -> 1.0).
    expect(weights.paper).toBe(99);
    expect(weights.decay_floor).toBe(1);
  });
});

describe('sanitizeReputationWeights — value validation and clamping', () => {
  it('clamps decay_floor to [0, 1]', () => {
    expect(sanitizeReputationWeights({ decay_floor: 1.5 }).decay_floor).toBe(1);
    expect(sanitizeReputationWeights({ decay_floor: -0.2 }).decay_floor).toBe(0);
    expect(sanitizeReputationWeights({ decay_floor: 0.3 }).decay_floor).toBe(0.3);
  });

  it('clamps self_citation_discount to [0, 1]', () => {
    expect(sanitizeReputationWeights({ self_citation_discount: 5 }).self_citation_discount).toBe(1);
    expect(sanitizeReputationWeights({ self_citation_discount: -1 }).self_citation_discount).toBe(0);
  });

  it('clamps decay_rate and decay_grace_months to >= 0', () => {
    expect(sanitizeReputationWeights({ decay_rate: -1 }).decay_rate).toBe(0);
    expect(sanitizeReputationWeights({ decay_grace_months: -3 }).decay_grace_months).toBe(0);
  });

  it('drops non-numeric fields so the caller falls back to defaults', () => {
    const out = sanitizeReputationWeights({ paper: 'abc', review: 10 });
    expect(out.paper).toBeUndefined();
    expect(out.review).toBe(10);
    // The loader spreads over defaults, so an absent key keeps the default.
    expect({ ...DEFAULT_REPUTATION_WEIGHTS, ...out }.paper).toBe(DEFAULT_REPUTATION_WEIGHTS.paper);
  });

  it('drops NaN and Infinity values', () => {
    expect(sanitizeReputationWeights({ paper: NaN }).paper).toBeUndefined();
    expect(sanitizeReputationWeights({ citation: Infinity }).citation).toBeUndefined();
    expect(sanitizeReputationWeights({ review: -Infinity }).review).toBeUndefined();
  });

  it('ignores unknown fields entirely', () => {
    const out = sanitizeReputationWeights({ evil: 999, paper: 25 }) as Record<string, unknown>;
    expect(out.evil).toBeUndefined();
    expect(out.paper).toBe(25);
  });

  it('returns an empty object for non-object input', () => {
    expect(sanitizeReputationWeights(null)).toEqual({});
    expect(sanitizeReputationWeights(undefined)).toEqual({});
    expect(sanitizeReputationWeights('weights')).toEqual({});
    expect(sanitizeReputationWeights(42)).toEqual({});
  });

  it('passes a full valid payload through with clamps applied', () => {
    const out = sanitizeReputationWeights({
      paper: 30, review: 12, downvote: 3, citation: 4, citation_max: 18,
      accreditation_bonus: 6, self_citation_discount: 0.1, decay_rate: 0.03,
      decay_floor: 0.4, decay_grace_months: 5, cycle_blocks: 28800,
    });
    expect(out).toEqual({
      paper: 30, review: 12, downvote: 3, citation: 4, citation_max: 18,
      accreditation_bonus: 6, self_citation_discount: 0.1, decay_rate: 0.03,
      decay_floor: 0.4, decay_grace_months: 5, cycle_blocks: 28800,
    });
  });
});

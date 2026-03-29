import { describe, it, expect } from 'vitest';
import { DEFAULT_REPUTATION_WEIGHTS, type ReputationWeights } from '@pevo/contracts';
import { decay, computeReputation, type UserStats } from '../src/reputation.js';

function baseStats(): UserStats {
  return {
    paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null,
    paper_rshares: 0, review_rshares: 0, max_paper_rshares: 0, max_review_rshares: 0,
    papers: [], reviews: [], max_single_review_rshares: 0, external_citations: 0, self_citations: 0,
  };
}

const V1 = DEFAULT_REPUTATION_WEIGHTS;

// ─── decay() ────────────────────────────────────────────────

describe('decay()', () => {
  it('returns 1.0 when decay_rate is 0 (v1 behavior)', () => {
    expect(decay(0, V1)).toBe(1.0);
    expect(decay(100, V1)).toBe(1.0);
  });

  it('returns 1.0 within grace period', () => {
    const w: ReputationWeights = { ...V1, decay_rate: 0.02, decay_grace_months: 6 };
    expect(decay(0, w)).toBe(1.0);
    expect(decay(3, w)).toBe(1.0);
    expect(decay(6, w)).toBe(1.0);
  });

  it('decays linearly after grace period', () => {
    const w: ReputationWeights = { ...V1, decay_rate: 0.02, decay_grace_months: 6, decay_floor: 0.3 };
    expect(decay(12, w)).toBeCloseTo(0.88, 5);
    expect(decay(24, w)).toBeCloseTo(0.64, 5);
  });

  it('never goes below floor', () => {
    const w: ReputationWeights = { ...V1, decay_rate: 0.02, decay_grace_months: 6, decay_floor: 0.3 };
    expect(decay(50, w)).toBe(0.3);
    expect(decay(200, w)).toBe(0.3);
  });
});

// ─── v1 compatibility ───────────────────────────────────────

describe('computeReputation() v1 compatibility', () => {
  it('produces correct score with default weights and per-item data', async () => {
    const now = new Date().toISOString();
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 2,
      review_count: 3,
      citation_count: 1,
      first_pevo_post: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      papers: [{ created: now }, { created: now }],
      reviews: [
        { created: now, rshares: 0 },
        { created: now, rshares: 0 },
        { created: now, rshares: 0 },
      ],
      external_citations: 1,
      self_citations: 0,
    };

    const result = await computeReputation(stats, true, V1);
    expect(result.breakdown.papers).toBe(20);
    expect(result.breakdown.reviews).toBe(15);
    expect(result.breakdown.citations).toBe(8);
    expect(result.breakdown.accreditation).toBe(20);
    expect(result.breakdown.account_age).toBe(3);
    expect(result.score).toBe(66);
  });

  it('returns 0 for empty stats, unaccredited user', async () => {
    const result = await computeReputation(baseStats(), false, V1);
    expect(result.score).toBe(0);
  });

  it('clamps score to 100', async () => {
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 10,
      papers: Array.from({ length: 10 }, () => ({ created: new Date().toISOString() })),
      citation_count: 5,
      external_citations: 5,
      first_pevo_post: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const result = await computeReputation(stats, true, V1);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

// ─── v2: temporal decay ─────────────────────────────────────

describe('computeReputation() v2: temporal decay', () => {
  const W_DECAY: ReputationWeights = { ...V1, decay_rate: 0.02, decay_grace_months: 6 };

  it('reduces paper score for old papers', async () => {
    const oldDate = new Date(Date.now() - 24 * 30 * 24 * 60 * 60 * 1000).toISOString();
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ created: oldDate }],
    };

    const result = await computeReputation(stats, false, W_DECAY);
    expect(result.breakdown.papers).toBeLessThan(10);
    expect(result.breakdown.papers).toBeGreaterThan(0);
  });

  it('does not decay recent papers within grace period', async () => {
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ created: new Date().toISOString() }],
    };

    const result = await computeReputation(stats, false, W_DECAY);
    expect(result.breakdown.papers).toBe(10);
  });

  it('decays reviews too', async () => {
    const oldDate = new Date(Date.now() - 24 * 30 * 24 * 60 * 60 * 1000).toISOString();
    const stats: UserStats = {
      ...baseStats(),
      review_count: 1,
      reviews: [{ created: oldDate, rshares: 0 }],
    };

    const result = await computeReputation(stats, false, W_DECAY);
    expect(result.breakdown.reviews).toBeLessThan(5);
    expect(result.breakdown.reviews).toBeGreaterThan(0);
  });
});

// ─── v2: review quality weighting ───────────────────────────

describe('computeReputation() v2: review quality weighting', () => {
  const W_QUALITY: ReputationWeights = { ...V1, review_quality_bonus_max: 5 };

  it('adds quality bonus for highly-voted reviews', async () => {
    const now = new Date().toISOString();
    const stats: UserStats = {
      ...baseStats(),
      review_count: 1,
      reviews: [{ created: now, rshares: 1000 }],
      max_single_review_rshares: 1000,
    };

    const result = await computeReputation(stats, false, W_QUALITY);
    expect(result.breakdown.reviews).toBe(10);
  });

  it('caps quality bonus at max', async () => {
    const now = new Date().toISOString();
    const stats: UserStats = {
      ...baseStats(),
      review_count: 1,
      reviews: [{ created: now, rshares: 2000 }],
      max_single_review_rshares: 1000,
    };

    const result = await computeReputation(stats, false, W_QUALITY);
    expect(result.breakdown.reviews).toBe(10);
  });

  it('gives no bonus when review_quality_bonus_max is 0 (v1)', async () => {
    const now = new Date().toISOString();
    const stats: UserStats = {
      ...baseStats(),
      review_count: 1,
      reviews: [{ created: now, rshares: 1000 }],
      max_single_review_rshares: 1000,
    };

    const result = await computeReputation(stats, false, V1);
    expect(result.breakdown.reviews).toBe(5);
  });
});

// ─── v2: self-citation discounting ──────────────────────────

describe('computeReputation() v2: self-citation discounting', () => {
  it('discounts self-citations at 0.5', async () => {
    const w: ReputationWeights = { ...V1, self_citation_discount: 0.5 };
    const stats: UserStats = {
      ...baseStats(),
      citation_count: 4,
      external_citations: 2,
      self_citations: 2,
    };

    const result = await computeReputation(stats, false, w);
    expect(result.breakdown.citations).toBe(24);
  });

  it('excludes self-citations entirely when discount is 0', async () => {
    const w: ReputationWeights = { ...V1, self_citation_discount: 0.0 };
    const stats: UserStats = {
      ...baseStats(),
      citation_count: 4,
      external_citations: 2,
      self_citations: 2,
    };

    const result = await computeReputation(stats, false, w);
    expect(result.breakdown.citations).toBe(16);
  });

  it('counts all equally when discount is 1.0 (v1)', async () => {
    const stats: UserStats = {
      ...baseStats(),
      citation_count: 4,
      external_citations: 2,
      self_citations: 2,
    };

    const result = await computeReputation(stats, false, V1);
    expect(result.breakdown.citations).toBe(32);
  });

  it('falls back to citation_count when no v2 breakdown', async () => {
    const stats: UserStats = {
      ...baseStats(),
      citation_count: 3,
      external_citations: 0,
      self_citations: 0,
    };

    const result = await computeReputation(stats, false, V1);
    expect(result.breakdown.citations).toBe(24);
  });
});

import { describe, it, expect } from 'vitest';
import { DEFAULT_REPUTATION_WEIGHTS, type ReputationWeights } from '../src/types/index.js';
import { decay, computeReputation, voterWeight, voteInfluence, type UserStats, type Vote } from '../src/reputation.js';

const W = DEFAULT_REPUTATION_WEIGHTS;

function baseStats(): UserStats {
  return {
    paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null,
    papers: [], reviews: [], citations: [], self_citations: 0, external_citations: 0,
  };
}

const now = new Date().toISOString();
const emptyRepMap = new Map<string, number>();
/** Default active accounts set for tests — treats all test voters as active. */
const allActive = new Set(['voter1', 'voter2', 'voter3', 'a', 'b', 'up1', 'up2', 'down1', 'down2', 'down3', 'high', 'low', 'other', 'self', 'author0', 'author1', 'author2', 'author3', 'author4', 'author5', 'author6', 'author7', 'author8', 'author9', ...Array.from({ length: 30 }, (_, i) => `voter${i}`), ...Array.from({ length: 25 }, (_, i) => `v${i}`)]);
const emptyActive = new Set<string>();

// ─── decay() ────────────────────────────────────────────────

describe('decay()', () => {
  it('returns 1.0 within grace period', () => {
    expect(decay(0, W)).toBe(1.0);
    expect(decay(3, W)).toBe(1.0);
    expect(decay(6, W)).toBe(1.0);
  });

  it('decays linearly after grace period', () => {
    expect(decay(12, W)).toBeCloseTo(0.88, 5);
    expect(decay(24, W)).toBeCloseTo(0.64, 5);
  });

  it('never goes below floor', () => {
    expect(decay(50, W)).toBe(0.3);
    expect(decay(200, W)).toBe(0.3);
  });

  it('returns 1.0 when decay_rate is 0', () => {
    const w: ReputationWeights = { ...W, decay_rate: 0 };
    expect(decay(100, w)).toBe(1.0);
  });
});

// ─── voterWeight() ─────────────────────────────────────────

describe('voterWeight()', () => {
  it('returns 1.0 for undefined (bootstrap mode)', () => {
    expect(voterWeight(undefined)).toBe(1.0);
  });

  it('returns 0.4 floor for rep 0 (active voter)', () => {
    expect(voterWeight(0, true)).toBeCloseTo(0.4, 5);
  });

  it('returns 1.0 for rep 100 (active voter)', () => {
    expect(voterWeight(100, true)).toBeCloseTo(1.0, 5);
  });

  it('returns expected value for rep 60 (active voter)', () => {
    // 0.4 + 0.6 * sqrt(60/100) = 0.4 + 0.6 * 0.7746 = 0.8648
    expect(voterWeight(60, true)).toBeCloseTo(0.865, 2);
  });

  it('clamps to 1.0 for rep > 100', () => {
    expect(voterWeight(150)).toBe(1.0);
  });

  // ── Activity-gated branch (R9) ──

  it('inactive voter with rep 5 gets sqrt(5/100) ≈ 0.224 (no floor)', () => {
    // sqrt(5/100) = sqrt(0.05) ≈ 0.2236
    expect(voterWeight(5, false)).toBeCloseTo(0.2236, 3);
  });

  it('active voter with rep 5 gets 0.4 + 0.6*sqrt(5/100) ≈ 0.534 (floored at 0.4)', () => {
    // 0.4 + 0.6 * sqrt(0.05) = 0.4 + 0.6 * 0.2236 = 0.534
    expect(voterWeight(5, true)).toBeCloseTo(0.534, 2);
  });

  it('inactive voter with rep 0 gets weight 0 (no floor)', () => {
    expect(voterWeight(0, false)).toBeCloseTo(0.0, 5);
  });

  it('inactive voter with rep 100 gets 1.0', () => {
    expect(voterWeight(100, false)).toBeCloseTo(1.0, 5);
  });

  it('defaults to active branch when hasActivity omitted', () => {
    // Default parameter is true
    expect(voterWeight(0)).toBeCloseTo(0.4, 5);
    expect(voterWeight(5)).toBeCloseTo(0.534, 2);
  });
});

// ─── voteInfluence() ───────────────────────────────────────

describe('voteInfluence()', () => {
  const activeAll = new Set(['alice', 'bob', 'carol', 'unknown']);

  it('combines voter weight and vote strength', () => {
    const vote: Vote = { voter: 'alice', weight: 10000 };
    const repMap = new Map([['alice', 100]]);
    // voter_weight(100) = 1.0, strength = 10000/10000 = 1.0
    expect(voteInfluence(vote, repMap, activeAll)).toBeCloseTo(1.0, 5);
  });

  it('applies partial vote strength', () => {
    const vote: Vote = { voter: 'bob', weight: 2500 };
    const repMap = new Map([['bob', 100]]);
    // 1.0 * 2500/10000 = 0.25
    expect(voteInfluence(vote, repMap, activeAll)).toBeCloseTo(0.25, 5);
  });

  it('uses abs for negative weights', () => {
    const vote: Vote = { voter: 'carol', weight: -6000 };
    const repMap = new Map([['carol', 100]]);
    expect(voteInfluence(vote, repMap, activeAll)).toBeCloseTo(0.6, 5);
  });

  it('uses 1.0 voter weight when voter not in reputation map (bootstrap)', () => {
    const vote: Vote = { voter: 'unknown', weight: 10000 };
    expect(voteInfluence(vote, emptyRepMap, activeAll)).toBeCloseTo(1.0, 5);
  });

  // ── Activity-gated influence (R9) ──

  it('inactive voter with rep 5 has reduced influence (no floor)', () => {
    const vote: Vote = { voter: 'sybil', weight: 10000 };
    const repMap = new Map([['sybil', 5]]);
    const emptyActive = new Set<string>();
    // sqrt(5/100) * 1.0 ≈ 0.2236
    expect(voteInfluence(vote, repMap, emptyActive)).toBeCloseTo(0.2236, 3);
  });

  it('active voter with rep 5 gets floored influence', () => {
    const vote: Vote = { voter: 'active', weight: 10000 };
    const repMap = new Map([['active', 5]]);
    const activeSet = new Set(['active']);
    // 0.4 + 0.6 * sqrt(5/100) ≈ 0.534
    expect(voteInfluence(vote, repMap, activeSet)).toBeCloseTo(0.534, 2);
  });

  it('defaults to active branch when activeAccounts not provided', () => {
    const vote: Vote = { voter: 'someone', weight: 10000 };
    const repMap = new Map([['someone', 5]]);
    // No activeAccounts → defaults to hasActivity=true → 0.534
    expect(voteInfluence(vote, repMap)).toBeCloseTo(0.534, 2);
  });
});

// ─── computeReputation() — basics ──────────────────────────

describe('computeReputation() v3: basics', () => {
  it('returns 0 for empty stats, unaccredited user', async () => {
    const result = await computeReputation(baseStats(), false, W, emptyRepMap, allActive);
    expect(result.score).toBe(0);
    expect(result.breakdown.papers).toBe(0);
    expect(result.breakdown.reviews).toBe(0);
    expect(result.breakdown.citations).toBe(0);
    expect(result.breakdown.accreditation).toBe(0);
  });

  it('gives accreditation bonus only', async () => {
    const result = await computeReputation(baseStats(), true, W, emptyRepMap, allActive);
    expect(result.score).toBe(5);
    expect(result.breakdown.accreditation).toBe(5);
  });

  it('clamps score to 100', async () => {
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 10,
      papers: Array.from({ length: 10 }, () => ({
        permlink: 'paper',
        created: now,
        votes: [{ voter: 'voter1', weight: 10000 }],
        review_quality: null,
      })),
    };
    const result = await computeReputation(stats, true, W, emptyRepMap, allActive);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('has correct default weights: paper=20, review=10, accreditation_bonus=5', () => {
    expect(W.paper).toBe(20);
    expect(W.review).toBe(10);
    expect(W.accreditation_bonus).toBe(5);
  });
});

// ─── Papers: vote-gated scoring ────────────────────────────

describe('computeReputation() v3: paper scoring', () => {
  it('paper with no votes contributes 0', async () => {
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ permlink: 'p1', created: now, votes: [], review_quality: null }],
    };
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.papers).toBe(0);
  });

  it('paper with strong endorsement contributes up to W_paper', async () => {
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{
        permlink: 'p1', created: now,
        votes: [{ voter: 'a', weight: 10000 }],
        review_quality: null,
      }],
    };
    // quality=1.0, min(1.0, 20) = 1.0, penalty=0 → clamped to 1.0
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.papers).toBe(1); // 1.0 * min(1.0, 20) = 1.0 → rounds to 1
  });

  it('paper capped at W_paper with many upvotes', async () => {
    const votes: Vote[] = Array.from({ length: 30 }, (_, i) => ({
      voter: `voter${i}`, weight: 10000,
    }));
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ permlink: 'p1', created: now, votes, review_quality: null }],
    };
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.papers).toBe(20); // capped at W_paper
  });

  it('downvote penalty reduces paper score', async () => {
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{
        permlink: 'p1', created: now,
        votes: [
          { voter: 'up1', weight: 10000 },
          { voter: 'up2', weight: 10000 },
          { voter: 'down1', weight: -10000 },
        ],
        review_quality: null,
      }],
    };
    // upvotes = 2.0, downvotes = 1.0
    // quality(1.0) * min(2.0, 20) - 1.0 * 2 = 2.0 - 2.0 = 0
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.papers).toBe(0);
  });

  it('paper score can go negative from downvotes', async () => {
    const stats: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{
        permlink: 'p1', created: now,
        votes: [
          { voter: 'up1', weight: 10000 },
          { voter: 'down1', weight: -10000 },
          { voter: 'down2', weight: -10000 },
          { voter: 'down3', weight: -10000 },
        ],
        review_quality: null,
      }],
    };
    // upvotes = 1.0, downvotes = 3.0
    // 1.0 * min(1.0, 20) - 3.0 * 2 = 1.0 - 6.0 = -5.0, clamped to max(-20, -5.0) = -5.0
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.papers).toBeLessThan(0);
  });

  it('review star ratings affect quality multiplier', async () => {
    const votes: Vote[] = Array.from({ length: 25 }, (_, i) => ({
      voter: `voter${i}`, weight: 10000,
    }));
    // Good reviews: quality = 4.5/5 = 0.9
    const statsGood: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ permlink: 'p1', created: now, votes, review_quality: 0.9 }],
    };
    // Bad reviews: quality = 2.0/5 = 0.4
    const statsBad: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ permlink: 'p1', created: now, votes, review_quality: 0.4 }],
    };

    const good = await computeReputation(statsGood, false, W, emptyRepMap, allActive);
    const bad = await computeReputation(statsBad, false, W, emptyRepMap, allActive);

    // good: 0.9 * min(25, 20) = 18, bad: 0.4 * min(25, 20) = 8
    expect(good.breakdown.papers).toBe(18);
    expect(bad.breakdown.papers).toBe(8);
    expect(good.breakdown.papers).toBeGreaterThan(bad.breakdown.papers);
  });
});

// ─── Reviews: vote-gated scoring ───────────────────────────

describe('computeReputation() v3: review scoring', () => {
  it('review with no votes contributes 0', async () => {
    const stats: UserStats = {
      ...baseStats(),
      review_count: 1,
      reviews: [{ permlink: 'r1', created: now, votes: [] }],
    };
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.reviews).toBe(0);
  });

  it('review capped at W_review', async () => {
    const votes: Vote[] = Array.from({ length: 15 }, (_, i) => ({
      voter: `voter${i}`, weight: 10000,
    }));
    const stats: UserStats = {
      ...baseStats(),
      review_count: 1,
      reviews: [{ permlink: 'r1', created: now, votes }],
    };
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.reviews).toBe(10); // capped at W_review
  });
});

// ─── Citations ─────────────────────────────────────────────

describe('computeReputation() v3: citations', () => {
  it('external citation with quality 1.0 gives full W_citation', async () => {
    const stats: UserStats = {
      ...baseStats(),
      citation_count: 1,
      external_citations: 1,
      citations: [{
        citing_author: 'other',
        citing_permlink: 'cp1',
        citing_created: now,
        citing_quality: 1.0,
        reputation_relevant: true,
        is_self: false,
      }],
    };
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.citations).toBe(3); // W_citation = 3
  });

  it('self-citations near zero (0.05 discount)', async () => {
    const stats: UserStats = {
      ...baseStats(),
      citation_count: 1,
      self_citations: 1,
      citations: [{
        citing_author: 'self',
        citing_permlink: 'cp1',
        citing_created: now,
        citing_quality: 1.0,
        reputation_relevant: true,
        is_self: true,
      }],
    };
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    // 1.0 * 0.05 * 1.0 (decay) = 0.05, rounds to 0
    expect(result.breakdown.citations).toBe(0);
  });

  it('citation cap (citation_max: 15)', async () => {
    const citations = Array.from({ length: 10 }, (_, i) => ({
      citing_author: `author${i}`,
      citing_permlink: `cp${i}`,
      citing_created: now,
      citing_quality: 1.0,
      reputation_relevant: true,
      is_self: false,
    }));
    const stats: UserStats = {
      ...baseStats(),
      citation_count: 10,
      external_citations: 10,
      citations,
    };
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    // 10 * 3 = 30 → capped at 15
    expect(result.breakdown.citations).toBe(15);
  });

  it('reputation_relevant: false citations excluded', async () => {
    const stats: UserStats = {
      ...baseStats(),
      citation_count: 2,
      external_citations: 2,
      citations: [
        {
          citing_author: 'a', citing_permlink: 'cp1', citing_created: now,
          citing_quality: 1.0, reputation_relevant: true, is_self: false,
        },
        {
          citing_author: 'b', citing_permlink: 'cp2', citing_created: now,
          citing_quality: 1.0, reputation_relevant: false, is_self: false,
        },
      ],
    };
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.citations).toBe(3); // only 1 relevant citation
  });

  it('citation from zero-quality paper contributes nothing', async () => {
    const stats: UserStats = {
      ...baseStats(),
      citation_count: 1,
      external_citations: 1,
      citations: [{
        citing_author: 'other',
        citing_permlink: 'cp1',
        citing_created: now,
        citing_quality: 0,
        reputation_relevant: true,
        is_self: false,
      }],
    };
    const result = await computeReputation(stats, false, W, emptyRepMap, allActive);
    expect(result.breakdown.citations).toBe(0);
  });
});

// ─── Voter weighting in context ────────────────────────────

describe('computeReputation() v3: voter weighting', () => {
  it('voter_weight formula: 0.4 + 0.6 * sqrt(rep/100)', async () => {
    const repMap = new Map([['high', 100], ['low', 0]]);

    const statsHigh: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ permlink: 'p1', created: now, votes: [{ voter: 'high', weight: 10000 }], review_quality: null }],
    };
    const statsLow: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ permlink: 'p1', created: now, votes: [{ voter: 'low', weight: 10000 }], review_quality: null }],
    };

    const high = await computeReputation(statsHigh, false, W, repMap, allActive);
    const low = await computeReputation(statsLow, false, W, repMap, allActive);

    // high: influence = 1.0, paper_rep = 1.0 * min(1.0, 20) = 1.0
    // low: influence = 0.4, paper_rep = 1.0 * min(0.4, 20) = 0.4
    expect(high.breakdown.papers).toBeGreaterThan(low.breakdown.papers);
  });
});

// ─── Temporal decay in v3 ──────────────────────────────────

describe('computeReputation() v3: temporal decay', () => {
  it('reduces paper score for old papers', async () => {
    const oldDate = new Date(Date.now() - 24 * 30 * 24 * 60 * 60 * 1000).toISOString();
    const votes: Vote[] = Array.from({ length: 25 }, (_, i) => ({ voter: `v${i}`, weight: 10000 }));

    const statsOld: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ permlink: 'p1', created: oldDate, votes, review_quality: null }],
    };
    const statsNew: UserStats = {
      ...baseStats(),
      paper_count: 1,
      papers: [{ permlink: 'p1', created: now, votes, review_quality: null }],
    };

    const old = await computeReputation(statsOld, false, W, emptyRepMap, allActive);
    const recent = await computeReputation(statsNew, false, W, emptyRepMap, allActive);

    expect(old.breakdown.papers).toBeLessThan(recent.breakdown.papers);
    expect(old.breakdown.papers).toBeGreaterThan(0);
  });
});

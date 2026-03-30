// PEvO Domain Types — shared data models from docs/hive-schemas.md

// ─── Paper ───────────────────────────────────────────────────────

export interface PaperAuthor {
  name: string;
  hive?: string;
  orcid?: string;
  affiliation?: string;
}

export interface Citation {
  author: string;
  permlink: string;
  title: string;
}

export interface Rating {
  methodology: number; // 1-5
  novelty: number;     // 1-5
  clarity: number;     // 1-5
  significance: number; // 1-5
}

// ─── Accreditation ───────────────────────────────────────────────

export type AccreditationMethod = "email" | "pgp" | "personal" | "wot" | "orcid" | "manual";

export interface Accreditation {
  name: string;
  institution: string;
  field: string;
  method: AccreditationMethod;
  timestamp: string;
}

// ─── Reputation ──────────────────────────────────────────────────

export interface ReputationBreakdown {
  papers: number;
  reviews: number;
  paper_votes: number;
  review_votes: number;
  citations: number;
  accreditation: number;
  account_age: number;
}

export interface ReputationScore {
  score: number;
  breakdown: ReputationBreakdown;
}

// ─── Reputation Weights (on-chain configurable) ──────────────────

export interface ReputationWeights {
  paper: number;
  review: number;
  paper_votes_max: number;
  review_votes_max: number;
  citation: number;
  accreditation_bonus: number;
  account_age_max: number;
  // v2 fields — defaults produce identical scores to v1
  self_citation_discount: number; // 0.0-1.0; 1.0 = no discount (v1 behavior)
  review_quality_bonus_max: number; // 0 = flat per-review scoring (v1 behavior)
  decay_rate: number; // 0.0 = no decay (v1 behavior)
  decay_floor: number; // minimum decay multiplier
  decay_grace_months: number; // months before decay begins
}

export const DEFAULT_REPUTATION_WEIGHTS: ReputationWeights = {
  paper: 10,
  review: 5,
  paper_votes_max: 30,
  review_votes_max: 15,
  citation: 8,
  accreditation_bonus: 20,
  account_age_max: 10,
  self_citation_discount: 1.0,
  review_quality_bonus_max: 0,
  decay_rate: 0.0,
  decay_floor: 0.3,
  decay_grace_months: 6,
};

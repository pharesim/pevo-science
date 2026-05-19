// PEvO Domain Types

// ─── Paper ───────────────────────────────────────────────────────

export interface PaperAuthor {
  name: string;
  hive?: string;
  orcid?: string;
  affiliation?: string;
  /** Accreditation-attested ORCID for the author's `hive` account when
   *  currently accredited AND the accreditation carries an ORCID. `null`
   *  otherwise. Populated read-time by the supersession projection per
   *  `agents/docs/hive-schemas.md` § 1.1.
   *
   *  Note: PaperSummary's runtime shape strips `affiliation` per the
   *  contract, even though the type leaves it optional. The supersession
   *  fields are optional on both PaperSummary and PaperDetail (absent when
   *  the caller didn't wire the orcid map; populated otherwise).
   */
  orcid_verified?: string | null;
  /** `true` IFF chain `orcid` and `orcid_verified` are both non-empty AND
   *  differ. Surfaces the discrepancy audit signal per ARCHITECTURE.md
   *  § 2 "Multi-Author Trust Model". */
  orcid_discrepancy?: boolean;
}

export interface Citation {
  author: string;
  permlink: string;
  title: string;
  reputation_relevant?: boolean;
}

export interface Rating {
  methodology: number; // 1-5
  novelty: number;     // 1-5
  clarity: number;     // 1-5
  significance: number; // 1-5
}

// ─── Accreditation ───────────────────────────────────────────────

export type AccreditationMethod = "email" | "wot" | "orcid" | "manual";

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
  citations: number;
  accreditation: number;
}

export interface ReputationScore {
  score: number;
  breakdown: ReputationBreakdown;
}

// ─── Reputation Weights (on-chain configurable) ──────────────────

export interface ReputationWeights {
  paper: number;
  review: number;
  downvote: number;
  citation: number;
  citation_max: number;
  accreditation_bonus: number;
  self_citation_discount: number; // 0.0-1.0; fraction of full credit for self-cites
  decay_rate: number;
  decay_floor: number; // minimum decay multiplier
  decay_grace_months: number; // months before decay begins
  cycle_blocks: number; // blocks per reputation cycle (~1 day at 3s/block)
}

export const DEFAULT_REPUTATION_WEIGHTS: ReputationWeights = {
  paper: 20,
  review: 10,
  downvote: 2,
  citation: 3,
  citation_max: 15,
  accreditation_bonus: 5,
  self_citation_discount: 0.05,
  decay_rate: 0.02,
  decay_floor: 0.3,
  decay_grace_months: 6,
  cycle_blocks: 28800,
};

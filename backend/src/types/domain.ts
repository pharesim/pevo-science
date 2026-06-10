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
   *  Runtime population:
   *   - SQL surfaces (`authorsWithSupersessionSelect` projection): the
   *     `jsonb_build_object` emits both supersession keys for every author
   *     entry the projection processes, defaulting to null/false via the
   *     CASE arms. The projection's outer WHERE drops entries that resolve
   *     no `name` via the name-COALESCE chain, so degenerate / nameless
   *     entries never reach the response.
   *   - JS surfaces (`applyAuthorSupersession`): non-object entries and
   *     fully-empty object entries resolve no `name` via the fallback chain
   *     and are filtered out by the helper's name-soundness drop before
   *     reaching any caller. Only entries that resolve a `name` survive,
   *     and those survivors always carry both supersession keys (defaulting
   *     to null/false when the hive is absent / unaccredited / carries no
   *     attested ORCID).
   *
   *  Both fields stay type-optional on `PaperAuthor` so partial-fixture
   *  construction (test inputs that pre-date supersession, manual
   *  hand-built author entries) does not require synthesizing the
   *  supersession defaults at every call site.
   *
   *  Note: PaperSummary's runtime shape strips `affiliation` per the
   *  contract, even though the type leaves it optional.
   */
  orcid_verified?: string | null;
  /** `true` IFF chain `orcid` and `orcid_verified` are both non-empty AND
   *  differ. Surfaces the discrepancy audit signal per ARCHITECTURE.md
   *  § 2 "Multi-Author Trust Model". */
  orcid_discrepancy?: boolean;
  /** `true` IFF the entry's `hive` account is in the paper's consented-author
   *  set (Routes 1+2 of the consent model: the root broadcaster, or an
   *  anchored co-author whose latest valid consent op is an `author_accept`).
   *  Hive-less entries are never consented through this flag. Populated by
   *  the paper-detail annotation layer only (listing/profile surfaces do not
   *  carry it); stays type-optional for the same partial-fixture reason as
   *  the supersession keys above. */
  consented?: boolean;
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

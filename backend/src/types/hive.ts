// PEvO Hive-specific types
// Defines the json_metadata shapes and custom_json payloads.

import type { PaperAuthor, Citation, Rating, AccreditationMethod, ReputationWeights } from "./domain.js";

// ─── Post json_metadata Shapes ───────────────────────────────────

export interface PevoBaseMeta {
  app: string; // "<APP_TAG>/0.1"
  tags: string[];
  [appTag: string]: unknown; // PEvO-specific metadata keyed by APP_TAG
}

export interface SupplementaryFile {
  cid: string;
  filename: string;
  type: string;        // MIME type
  size: number;        // bytes
  description?: string; // optional author-provided label
}

export interface AddressedReview {
  author: string;
  permlink: string;
}

export interface ContinuationPointer {
  author: string;
  permlink: string;
}

export interface PaperPevoMeta {
  type: "paper";
  /** Content version counter — incremented by the author on each edit (1 = first publication). */
  version: number;
  authors: PaperAuthor[];
  discipline: string;
  keywords: string[];
  ipfs_cid: string | null;
  ipfs_filename: string | null;
  language: string;
  document_hash: string | null;
  citations: Citation[];
  supplementary_files: SupplementaryFile[];
  /** Reviews explicitly addressed by this version. */
  addresses_reviews?: AddressedReview[];
  /** For continuation posts: points to the current chain head being continued. */
  continues?: ContinuationPointer;
}

export interface ReviewPevoMeta {
  type: "review";
  version: number;
  rating: Rating;
  is_anonymous: boolean;
  reviewer_attestation_id: string | null;
  /** Which version of the paper this review was written against. */
  reviewed_version: number;
}

// ─── Bridge Paper Source ──────────────────────────────────────────

export type BridgeSourceType = "arxiv" | "crossref";

export interface BridgePaperSource {
  type: BridgeSourceType;
  doi: string | null;
  arxiv_id: string | null;
  url: string;
  pdf_url: string | null;
  published_date: string;
  source_name: string;
  license: string | null;
  registered_by: string;
}

export interface BridgePaperPevoMeta {
  type: "bridge_paper";
  version: number;
  authors: PaperAuthor[];
  discipline: string;
  keywords: string[];
  language: string;
  citations: Citation[];
  ipfs_cid: null;
  ipfs_filename: null;
  document_hash: null;
  source: BridgePaperSource;
}

export interface BridgePaperJsonMetadata extends PevoBaseMeta {
  canonical_url: string;
  // APP_TAG key maps to BridgePaperPevoMeta at runtime
}

export interface CommentPevoMeta {
  type: "comment";
  version: number;
}

export type PevoMeta = PaperPevoMeta | ReviewPevoMeta | BridgePaperPevoMeta | CommentPevoMeta;

export interface PaperJsonMetadata extends PevoBaseMeta {
  canonical_url: string;
  image?: string[];
  // APP_TAG key maps to PaperPevoMeta at runtime
}

export interface ReviewJsonMetadata extends PevoBaseMeta {
  // APP_TAG key maps to ReviewPevoMeta at runtime
}

export interface CommentJsonMetadata extends PevoBaseMeta {
  // APP_TAG key maps to CommentPevoMeta at runtime
}

// ─── custom_json Payloads ────────────────────────────────────────

export interface AccreditAction {
  action: "accredit";
  account: string;
  name: string;
  institution: string;
  field: string;
  method: AccreditationMethod;
  evidence_hash: string;
  timestamp: string;
}

export interface RevokeAction {
  action: "revoke";
  account: string;
  reason: string;
  timestamp: string;
}

export interface AnonReviewAction {
  action: "anon_review";
  review_permlink: string;
  paper_author: string;
  paper_permlink: string;
  attestation_id: string;
  expires: string;
  timestamp: string;
}

export interface UpdateWeightsAction {
  action: "update_weights";
  weights: Partial<ReputationWeights>; // missing fields use DEFAULT_REPUTATION_WEIGHTS
  rationale: string;
  timestamp: string;
}

export interface UpdateParamsAction {
  action: "update_params";
  params: {
    max_upload_size_mb?: number;
    anon_review_ttl_days?: number;
    min_accreditations_for_wot?: number;
  };
  rationale: string;
  timestamp: string;
}

// ─── Web of Trust (WoT) ──────────────────────────────────────────

export type VouchRelationship = "colleague" | "advisor" | "collaborator";

export interface VouchAction {
  action: "vouch";
  voucher: string;
  vouchee: string;
  relationship: VouchRelationship;
  timestamp: string;
}

export interface RetractVouchAction {
  action: "retract_vouch";
  voucher: string;
  vouchee: string;
  reason: string;
  timestamp: string;
}

export interface RetractPaperAction {
  action: "retract_paper";
  author: string;
  permlink: string;
  reason: string;
  timestamp: string;
}

export interface RevoteAction {
  action: "revote";
  author: string;
  permlink: string;
  weight: number;    // -10000 to 10000, same scale as Hive votes; 0 retracts
  version: number;   // paper version at time of re-vote
}

export type PevoCustomJsonAction =
  | AccreditAction
  | RevokeAction
  | AnonReviewAction
  | UpdateWeightsAction
  | UpdateParamsAction
  | VouchAction
  | RetractVouchAction
  | RetractPaperAction
  | RevoteAction;

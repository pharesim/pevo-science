// PEvO Hive-specific types — from docs/hive-schemas.md
// Defines the json_metadata shapes and custom_json payloads.

import type { PaperAuthor, Citation, Rating, AccreditationMethod, ReputationWeights } from "./domain.js";

// ─── Post json_metadata Shapes ───────────────────────────────────

export interface PevoBaseMeta {
  app: string; // "pevo/0.1"
  tags: string[];
  format: "markdown";
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
  abstract_hash: string;
  document_hash: string | null;
  /** SHA-256 of (title + "\n" + body). Used to distinguish content revisions from metadata-only edits. */
  content_hash: string;
  citations: Citation[];
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
  abstract_hash: string;
  /** SHA-256 of (title + "\n" + body). Used to distinguish content revisions from metadata-only edits. */
  content_hash: string;
  citations: Citation[];
  ipfs_cid: null;
  ipfs_filename: null;
  document_hash: null;
  source: BridgePaperSource;
}

export interface BridgePaperJsonMetadata extends PevoBaseMeta {
  pevo: BridgePaperPevoMeta;
}

export interface CommentPevoMeta {
  type: "comment";
  version: number;
}

export type PevoMeta = PaperPevoMeta | ReviewPevoMeta | BridgePaperPevoMeta | CommentPevoMeta;

export interface PaperJsonMetadata extends PevoBaseMeta {
  pevo: PaperPevoMeta;
}

export interface ReviewJsonMetadata extends PevoBaseMeta {
  pevo: ReviewPevoMeta;
}

export interface CommentJsonMetadata extends PevoBaseMeta {
  pevo: CommentPevoMeta;
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
  encrypted_reviewer: string;
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

export interface AssignDoiAction {
  action: "assign_doi";
  author: string;
  permlink: string;
  doi: string;
  doi_url: string;
  timestamp: string;
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
  | AssignDoiAction;

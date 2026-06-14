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
  // Authority attribution: WHO/WHAT caused this op. For the automated
  // self-service flows (email/ORCID/signup) the admin account itself is the
  // accreditor (config.hiveAdminAccount); WoT auto-accreditation uses the
  // 'wot' system marker; a human-admin-initiated accredit would carry that
  // admin's account. See admin-roster.ts.
  issued_by: string;
  timestamp: string;
}

export interface RevokeAction {
  action: "revoke";
  account: string;
  reason: string;
  // Authority attribution (see AccreditAction). WoT auto-revocations carry the
  // 'wot' system marker; a deliberate admin sanction carries the acting admin.
  issued_by: string;
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
  // Authority attribution (see AccreditAction). NOTE: the backend has no
  // update_weights BROADCAST site today (it is only read/validated from chain
  // in reputation.ts / reputation-batch.ts), so nothing stamps this field yet;
  // it is defined here for forward-compat and for the type to match the
  // attribution convention if a root-gated broadcast endpoint is added.
  issued_by?: string;
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

// ─── Admin roster ops (human-authorization layer) ────────────────
//
// The admin roster is chain-derived (no persistent table): the live tier per
// account is the latest non-revoked `admin_grant` per account, read via
// `activeAdminsCteBody` (hafsql.ts) and resolved by `admin-roster.ts`. Both
// ops are signed by the single `config.hiveAdminAccount` (`pevo.admin`) signer
// via `broadcastAdminCustomJson` — they do NOT widen the signer; they record
// WHICH human (`issued_by`) the operator-controlled key acted on behalf of.
// `level` is the granted/revoked tier; `root` is bootstrap config and is never
// represented as a grant. Ordering/latest-wins reads from CHAIN BLOCK TIME,
// not the payload `timestamp` (mirrors the accredit tenure convention).
export interface AdminGrantAction {
  action: "admin_grant";
  account: string;
  level: "admin" | "super_admin";
  issued_by: string;
  timestamp: string;
}

export interface AdminRevokeAction {
  action: "admin_revoke";
  account: string;
  level: "admin" | "super_admin";
  reason: string;
  issued_by: string;
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
  // Authority attribution (see AccreditAction): the acting human (paper author
  // self-retract, or the admin who retracted).
  issued_by: string;
  timestamp: string;
}

export interface RevoteAction {
  action: "revote";
  author: string;
  permlink: string;
  weight: number;    // -10000 to 10000, same scale as Hive votes; 0 retracts
  version: number;   // paper version at time of re-vote
}

// ─── Multi-author consent ops (ARCH.md "Multi-Author Trust Model") ──
//
// `author_accept` / `author_resign` register a claimed author's vouched
// status for a paper. The chain signer (`required_posting_auths[0]`) IS
// the accepting/resigning author — binding is implicit since the wire
// format carries no payload subject identity field. See ARCH.md "Author
// Accept (custom_json)" / "Author Resign (custom_json)" for full
// validity rules; consent-ops.ts implements the read-time computation.
//
// Discriminator note: ARCH.md's wire-format snippets use `type:` for these
// ops, but every other PEvO custom_json op uses `action:` (see
// AccreditAction, RevokeAction, VouchAction, etc.) and the broadcast and
// parsing infrastructure (custody.ts allowedActions, accreditations.ts,
// reputation.ts, notification-queries.ts) all key on `payload.action`.
// Implementing with `action:` to match the universal codebase convention.
// [TODO Architect] ARCH.md "Author Accept (custom_json)" and "Author
// Resign (custom_json)" subsections should switch the schema discriminator
// from `type:` to `action:` for spec-vs-code alignment.

export interface AuthorAcceptAction {
  action: "author_accept";
  root_author: string;
  root_permlink: string;
}

export interface AuthorResignAction {
  action: "author_resign";
  root_author: string;
  root_permlink: string;
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
  | RevoteAction
  | AuthorAcceptAction
  | AuthorResignAction
  | AdminGrantAction
  | AdminRevokeAction;

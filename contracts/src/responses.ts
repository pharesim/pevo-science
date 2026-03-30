// PEvO API Response Shapes — from docs/api-contract.md
// These define exactly what the API returns for each endpoint.

import type {
  PaperAuthor,
  Citation,
  Rating,
  Accreditation,
  ReputationBreakdown,
  AccreditationMethod,
} from "./domain.js";

// ─── Paper Responses ─────────────────────────────────────────────

export interface PaperSummary {
  author: string;
  permlink: string;
  title: string;
  abstract: string;
  discipline: string;
  keywords: string[];
  authors: PaperAuthor[];
  ipfs_cid: string | null;
  created: string;
  net_votes: number;
  review_count: number;
  citation_count: number;
  author_reputation: number;
  is_accredited: boolean;
  source_type: "native" | "arxiv" | "crossref";
}

export interface ReviewInPaper {
  author: string;
  permlink: string;
  body: string;
  rating: Rating;
  is_anonymous: boolean;
  created: string;
  net_votes: number;
  reviewer_reputation: number;
  is_accredited: boolean;
  /** Which version of the paper this review was written against. */
  reviewed_version: number;
}

export interface PaperVersion {
  version_number: number;
  created: string;
  title: string;
  /** True when this version changed the paper content (title/body), false for metadata-only edits. */
  is_content_revision: boolean;
}

export interface PaperDetail {
  author: string;
  permlink: string;
  title: string;
  abstract: string | null;
  body: string;
  json_metadata: Record<string, unknown>;
  created: string;
  last_update: string;
  net_votes: number;
  discipline: string;
  keywords: string[];
  authors: PaperAuthor[];
  ipfs_cid: string | null;
  ipfs_filename: string | null;
  document_hash: string | null;
  abstract_hash: string;
  language: string;
  citations: Citation[];
  citation_count: number;
  author_reputation: number;
  is_accredited: boolean;
  reviews: ReviewInPaper[];
  versions: PaperVersion[];
  is_retracted: boolean;
  retraction_reason?: string | null;
  retraction_timestamp?: string | null;
}

// ─── Discussion Comment Responses ────────────────────────────

export interface DiscussionComment {
  author: string;
  permlink: string;
  body: string;
  created: string;
  net_votes: number;
  is_accredited: boolean;
  author_reputation: number;
  parent_author: string;
  parent_permlink: string;
  replies: DiscussionComment[];
}

// ─── Review Responses ────────────────────────────────────────────

export interface ReviewDetail {
  author: string;
  permlink: string;
  body: string;
  rating: Rating;
  is_anonymous: boolean;
  reviewer_attestation_id: string | null;
  paper: {
    author: string;
    permlink: string;
    title: string;
  };
  created: string;
  net_votes: number;
  reviewer_reputation: number;
  is_accredited: boolean;
}

// ─── Profile Responses ───────────────────────────────────────────

export interface Profile {
  username: string;
  is_accredited: boolean;
  accreditation: Accreditation | null;
  reputation: {
    score: number;
    breakdown: ReputationBreakdown;
  };
  stats: {
    paper_count: number;
    review_count: number;
    citation_count: number;
    first_pevo_post: string | null;
  };
}

// ─── Accreditation Responses ─────────────────────────────────────

export interface AccreditedResearcher {
  username: string;
  name: string;
  institution: string;
  field: string;
  method: AccreditationMethod;
  timestamp: string;
}

export interface AccreditationRequest {
  full_name: string;
  institution: string;
  field: string;
  email: string;
  orcid?: string;
}

export interface AccreditationRequestResponse {
  message: string;
  expires_at: string;
}

export interface AccreditationVerifyResponse {
  message: string;
  username: string;
  tx_id: string;
}

export interface AccreditationStatus {
  username: string;
  is_accredited: boolean;
  accreditation: Accreditation | null;
}

// ─── Web of Trust (WoT) Responses ────────────────────────────────

export interface VouchInfo {
  voucher: string;
  relationship: string;
  timestamp: string;
}

export interface VouchStatus {
  username: string;
  vouch_count: number;
  threshold: number;
  vouches: VouchInfo[];
  eligible: boolean;
}

// ─── Search Responses ────────────────────────────────────────────

export interface SearchResult {
  type: "paper" | "review";
  author: string;
  permlink: string;
  title: string;
  snippet: string;
  rank: number;
  created: string;
  is_accredited: boolean;
}

// ─── Disciplines & Stats ─────────────────────────────────────────

export interface Discipline {
  name: string;
  paper_count: number;
}

export interface PlatformStats {
  total_papers: number;
  total_bridge_papers: number;
  total_reviews: number;
  total_accredited_researchers: number;
  total_citations: number;
  active_disciplines: number;
  papers_last_30_days: number;
  reviews_last_30_days: number;
}

// ─── IPFS ────────────────────────────────────────────────────────

export interface IpfsUploadResponse {
  cid: string;
  size: number;
  filename: string;
}

// ─── Anonymous Review ────────────────────────────────────────────

export interface AnonymousReviewRequest {
  paper_author: string;
  paper_permlink: string;
  body: string;
  rating: Rating;
}

export interface AnonymousReviewResponse {
  author: string; // always "pevo.anon"
  permlink: string;
  tx_id: string;
}

// ─── Notifications ──────────────────────────────────────────────

export type NotificationEventType =
  | "new_review"
  | "new_citation"
  | "new_vote"
  | "accreditation_update"
  | "new_vouch"
  | "new_reply";

export interface BaseNotificationEvent {
  type: NotificationEventType;
  block_num: number;
  timestamp: string;
}

export interface NewReviewEvent extends BaseNotificationEvent {
  type: "new_review";
  actor: string;
  paper_author: string;
  paper_permlink: string;
  paper_title: string;
  permlink: string;
}

export interface NewCitationEvent extends BaseNotificationEvent {
  type: "new_citation";
  actor: string;
  paper_author: string;
  paper_permlink: string;
  paper_title: string;
  citing_permlink: string;
}

export interface NewVoteEvent extends BaseNotificationEvent {
  type: "new_vote";
  actor: string;
  target_author: string;
  target_permlink: string;
  target_type: "paper" | "review";
  weight: number;
}

export interface AccreditationUpdateEvent extends BaseNotificationEvent {
  type: "accreditation_update";
  action: "accredit" | "revoke";
  method?: string;
}

export interface NewVouchEvent extends BaseNotificationEvent {
  type: "new_vouch";
  actor: string;
  relationship: string;
}

export interface NewReplyEvent extends BaseNotificationEvent {
  type: "new_reply";
  actor: string;
  parent_author: string;
  parent_permlink: string;
  paper_author: string;
  paper_permlink: string;
  permlink: string;
}

export type NotificationEvent =
  | NewReviewEvent
  | NewCitationEvent
  | NewVoteEvent
  | AccreditationUpdateEvent
  | NewVouchEvent
  | NewReplyEvent;

export interface NotificationBatch {
  events: NotificationEvent[];
  latest_block: number;
  has_more: boolean;
}

// ─── Preprint Bridge ─────────────────────────────────────────────

export interface BridgeLookupAuthor {
  name: string;
  orcid: string | null;
  affiliation: string | null;
}

export interface BridgeLookupResult {
  source_type: "arxiv" | "crossref";
  doi: string | null;
  arxiv_id: string | null;
  title: string;
  authors: BridgeLookupAuthor[];
  abstract: string;
  published_date: string;
  source_name: string;
  source_url: string;
  pdf_url: string | null;
  license: string | null;
  subjects: string[];
}

export interface BridgeCheckResult {
  exists: boolean;
  author: string | null;
  permlink: string | null;
  title: string | null;
  created: string | null;
}

export interface BridgeSourceInfo {
  type: "arxiv" | "crossref";
  doi: string | null;
  arxiv_id: string | null;
  url: string;
}

export interface RegisterBridgePaperResponse {
  author: string;
  permlink: string;
  tx_id: string;
  source: BridgeSourceInfo;
}

export interface UpdateBridgePaperResponse {
  author: string;
  permlink: string;
  tx_id: string;
  previous_version: number;
  new_version: number;
}

// ─── Session Auth ───────────────────────────────────────────────

export interface SessionResponse {
  token: string;
  expires_at: string;
}

// ─── Health Check ────────────────────────────────────────────────

export interface HealthCheckResponse {
  status: string;
  haf_available: boolean;
  timestamp: string;
}

// ─── ORCID Accreditation ──────────────────────────────────────

export interface OrcidStartResponse {
  redirect_url: string;
}

export interface OrcidCallbackResponse {
  message: string;
  username: string;
  orcid: string;
  tx_id: string;
}

// ─── Citation Export ──────────────────────────────────────────

export type CitationFormat = "bibtex" | "ris" | "apa";

export interface CitationExportResponse {
  format: CitationFormat;
  content: string;
}

// ─── Paper Retraction ─────────────────────────────────────────

export interface RetractPaperResponse {
  message: string;
  tx_id: string;
}

// ─── DOI ─────────────────────────────────────────────────────

export type DoiStatus = "registered" | "unregistered";

export interface DoiResponse {
  doi: string | null;
  doi_url: string | null;
  status: DoiStatus;
  registered_at: string | null;
}

// ─── Notification Preferences ────────────────────────────────

export type DigestFrequency = "daily" | "weekly";

export interface NotificationPreferences {
  username: string;
  email_digest: boolean;
  digest_frequency: DigestFrequency;
  email: string | null;
  updated_at: string | null;
}

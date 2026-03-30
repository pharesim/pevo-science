import { z } from "zod";

// ─── Domain Schemas ─────────────────────────────────────────────

const AccreditationMethodSchema = z.enum(["email", "pgp", "personal", "wot", "orcid", "manual"]);

const AccreditationSchema = z.object({
  name: z.string(),
  institution: z.string(),
  field: z.string(),
  method: AccreditationMethodSchema,
  timestamp: z.string(),
});

const ReputationBreakdownSchema = z.object({
  papers: z.number(),
  reviews: z.number(),
  paper_votes: z.number(),
  review_votes: z.number(),
  citations: z.number(),
  accreditation: z.number(),
  account_age: z.number(),
});

const RatingSchema = z.object({
  methodology: z.number(),
  novelty: z.number(),
  clarity: z.number(),
  significance: z.number(),
});

const PaperAuthorSchema = z.object({
  name: z.string(),
  hive: z.string().optional(),
  orcid: z.string().optional(),
  affiliation: z.string().optional(),
});

const CitationSchema = z.object({
  author: z.string(),
  permlink: z.string(),
  title: z.string(),
});

// ─── Response Schemas ───────────────────────────────────────────

/** Profile — matches contracts Profile type */
export const ProfileSchema = z.object({
  username: z.string(),
  is_accredited: z.boolean(),
  accreditation: AccreditationSchema.nullable(),
  reputation: z.object({
    score: z.number(),
    breakdown: ReputationBreakdownSchema,
  }),
  stats: z.object({
    paper_count: z.number(),
    review_count: z.number(),
    citation_count: z.number(),
    first_pevo_post: z.string().nullable(),
  }),
});

/** AccreditationStatus — matches contracts AccreditationStatus type */
export const AccreditationStatusSchema = z.object({
  username: z.string(),
  is_accredited: z.boolean(),
  accreditation: AccreditationSchema.nullable(),
});

/** AccreditationVerifyResponse — matches contracts AccreditationVerifyResponse type */
export const AccreditationVerifySchema = z.object({
  message: z.string(),
  username: z.string(),
  tx_id: z.string(),
});

/** VouchInfo — used inside VouchStatus */
const VouchInfoSchema = z.object({
  voucher: z.string(),
  relationship: z.string(),
  timestamp: z.string(),
});

/** VouchStatus — matches contracts VouchStatus type */
export const VouchStatusSchema = z.object({
  username: z.string(),
  vouch_count: z.number(),
  threshold: z.number(),
  vouches: z.array(VouchInfoSchema),
  eligible: z.boolean(),
});

/** ReviewInPaper — used inside PaperDetail */
const ReviewInPaperSchema = z.object({
  author: z.string(),
  permlink: z.string(),
  body: z.string(),
  rating: RatingSchema,
  is_anonymous: z.boolean(),
  created: z.string(),
  net_votes: z.number(),
  reviewer_reputation: z.number(),
  is_accredited: z.boolean(),
  reviewed_version: z.number(),
});

const PaperVersionSchema = z.object({
  version_number: z.number(),
  created: z.string(),
  title: z.string(),
  is_content_revision: z.boolean(),
});

/** PaperDetail — matches contracts PaperDetail type */
export const PaperDetailSchema = z.object({
  author: z.string(),
  permlink: z.string(),
  title: z.string(),
  abstract: z.string().nullable(),
  body: z.string(),
  json_metadata: z.record(z.string(), z.unknown()),
  created: z.string(),
  last_update: z.string(),
  net_votes: z.number(),
  discipline: z.string(),
  keywords: z.array(z.string()),
  authors: z.array(PaperAuthorSchema),
  ipfs_cid: z.string().nullable(),
  ipfs_filename: z.string().nullable(),
  document_hash: z.string().nullable(),
  abstract_hash: z.string(),
  language: z.string(),
  citations: z.array(CitationSchema),
  citation_count: z.number(),
  author_reputation: z.number(),
  is_accredited: z.boolean(),
  reviews: z.array(ReviewInPaperSchema),
  versions: z.array(PaperVersionSchema),
  is_retracted: z.boolean(),
  retraction_reason: z.string().nullable().optional(),
  retraction_timestamp: z.string().nullable().optional(),
});

/** ReviewDetail — matches contracts ReviewDetail type */
export const ReviewDetailSchema = z.object({
  author: z.string(),
  permlink: z.string(),
  body: z.string(),
  rating: RatingSchema,
  is_anonymous: z.boolean(),
  reviewer_attestation_id: z.string().nullable(),
  paper: z.object({
    author: z.string(),
    permlink: z.string(),
    title: z.string(),
  }),
  created: z.string(),
  net_votes: z.number(),
  reviewer_reputation: z.number(),
  is_accredited: z.boolean(),
});

// ─── Notification Schemas (discriminated union) ─────────────────

const BaseNotificationFields = {
  block_num: z.number(),
  timestamp: z.string(),
};

const NewReviewEventSchema = z.object({
  type: z.literal("new_review"),
  ...BaseNotificationFields,
  actor: z.string(),
  paper_author: z.string(),
  paper_permlink: z.string(),
  paper_title: z.string(),
  permlink: z.string(),
});

const NewCitationEventSchema = z.object({
  type: z.literal("new_citation"),
  ...BaseNotificationFields,
  actor: z.string(),
  paper_author: z.string(),
  paper_permlink: z.string(),
  paper_title: z.string(),
  citing_permlink: z.string(),
});

const NewVoteEventSchema = z.object({
  type: z.literal("new_vote"),
  ...BaseNotificationFields,
  actor: z.string(),
  target_author: z.string(),
  target_permlink: z.string(),
  target_type: z.enum(["paper", "review"]),
  weight: z.number(),
});

const AccreditationUpdateEventSchema = z.object({
  type: z.literal("accreditation_update"),
  ...BaseNotificationFields,
  action: z.enum(["accredit", "revoke"]),
  method: z.string().optional(),
});

const NewVouchEventSchema = z.object({
  type: z.literal("new_vouch"),
  ...BaseNotificationFields,
  actor: z.string(),
  relationship: z.string(),
});

const NewReplyEventSchema = z.object({
  type: z.literal("new_reply"),
  ...BaseNotificationFields,
  actor: z.string(),
  parent_author: z.string(),
  parent_permlink: z.string(),
  paper_author: z.string(),
  paper_permlink: z.string(),
  permlink: z.string(),
});

/** NotificationEvent — discriminated union matching contracts NotificationEvent */
export const NotificationEventSchema = z.discriminatedUnion("type", [
  NewReviewEventSchema,
  NewCitationEventSchema,
  NewVoteEventSchema,
  AccreditationUpdateEventSchema,
  NewVouchEventSchema,
  NewReplyEventSchema,
]);

/** NotificationBatch — matches contracts NotificationBatch */
export const NotificationBatchSchema = z.object({
  events: z.array(NotificationEventSchema),
  latest_block: z.number(),
  has_more: z.boolean(),
});

// PEvO API Types — canonical definitions
// Both frontend and backend should import from this package.

// ─── Common Envelope ─────────────────────────────────────────────

export interface ApiResponse<T> {
  status: "ok";
  data: T;
  meta?: PaginationMeta;
}

export interface ApiError {
  status: "error";
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "FILE_TOO_LARGE"
  | "INVALID_FILE_TYPE"
  | "RATE_LIMITED"
  | "ACCOUNT_LOCKED"
  | "BROADCAST_FAILED"
  | "BROADCAST_TIMEOUT"
  | "BROADCAST_ATTEMPT_LIMIT_EXCEEDED"
  | "POST_BROADCAST_FAILED"
  | "ALREADY_UPGRADED"
  | "SESSION_INVALIDATED"
  | "INVALID_TOKEN"
  | "PENDING_SIGNUP"
  | "PENDING_UNVERIFIED"
  | "SIGNUP_EXPIRED"
  | "NO_ACCOUNT"
  | "ORCID_ALREADY_LINKED"
  | "NO_PASSWORD_SET"
  | "PASSWORD_ALREADY_SET"
  | "ORCID_REQUIRED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
}

// ─── Query Params ────────────────────────────────────────────────

export type PaperSortOption = "date" | "reputation" | "votes";
export type SearchSortOption = "relevance" | "date";
export type SortOrder = "asc" | "desc";
export type SearchContentType = "paper" | "review" | "all";

export type PaperSourceFilter = "native" | "bridge";

export interface PaperListParams {
  discipline?: string;
  keyword?: string;
  author?: string;
  sort?: PaperSortOption;
  order?: SortOrder;
  accredited_only?: boolean;
  source?: PaperSourceFilter;
  page?: number;
  limit?: number;
}

export interface SearchParams {
  q: string;
  type?: SearchContentType;
  discipline?: string;
  source?: PaperSourceFilter;
  accredited_only?: boolean;
  sort?: SearchSortOption;
  page?: number;
  limit?: number;
}

// ─── Contact ────────────────────────────────────────────────────

export type ContactCategory = "bug" | "accreditation" | "keychain" | "general";

export interface ContactSubmission {
  category: ContactCategory;
  email: string;
  subject: string;
  message: string;
}

import type { z } from "zod";
import { captureException } from "@/lib/errorTracking";
import type {
  ApiResponse,
  ApiError,
  PaperSummary,
  PaperDetail,
  Profile,
  Discipline,
  SearchResult,
  IpfsUploadResponse,
  AccreditationRequest,
  AccreditationRequestResponse,
  AccreditationVerifyResponse,
  PaperListParams,
  SearchParams,
  AnonymousReviewRequest,
  AnonymousReviewResponse,
  ReviewDetail,
  AccreditedResearcher,
  AccreditationStatus,
  PlatformStats,
  HealthCheckResponse,
  DiscussionComment,
  VouchStatus,
  NotificationBatch,
  OrcidStartResponse,
  CitationFormat,
  CitationExportResponse,
  RetractPaperResponse,
  DoiResponse,
  NotificationPreferences,
  DigestFrequency,
  BridgeLookupResult,
  BridgeCheckResult,
  RegisterBridgePaperResponse,
  UpdateBridgePaperResponse,
  ContactSubmission,
} from "@pevo/contracts";
import {
  ProfileSchema,
  AccreditationStatusSchema,
  AccreditationVerifySchema,
  PaperDetailSchema,
  ReviewDetailSchema,
  VouchStatusSchema,
  NotificationBatchSchema,
} from "./schemas";

// Server-side rendering (RSC) runs inside the Docker container where
// NEXT_PUBLIC_API_URL (e.g. api.pevo.lvh.me:8090) resolves to 127.0.0.1
// and is unreachable.  Use INTERNAL_API_URL (e.g. http://backend:3001)
// for SSR, and the public URL for browser requests.
const isServer = typeof window === "undefined";
export const BASE_URL = isServer
  ? (process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001")
  : (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001");

// Warn at build/startup if API URL is not explicitly configured
if (
  typeof process !== "undefined" &&
  process.env.NODE_ENV === "production" &&
  !process.env.NEXT_PUBLIC_API_URL
) {
  console.error(
    "FATAL: NEXT_PUBLIC_API_URL is not set. The frontend will not be able to reach the API in production."
  );
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ApiRequestError";
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  schema?: z.ZodType<T>,
): Promise<ApiResponse<T>> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    ...init,
  });

  if (!res.ok) {
    let errorBody: ApiError | null = null;
    try {
      errorBody = await res.json();
    } catch {
      // Response is not JSON
    }
    if (errorBody && errorBody.status === "error") {
      const err = new ApiRequestError(errorBody.error.code, errorBody.error.message);
      captureException(err, { path, status: res.status });
      throw err;
    }
    const err = new ApiRequestError("INTERNAL_ERROR", `Request failed with status ${res.status}`);
    captureException(err, { path, status: res.status });
    throw err;
  }

  const json: ApiResponse<T> = await res.json();

  if (schema) {
    const result = schema.safeParse(json.data);
    if (!result.success) {
      const validationErr = new ApiRequestError("INVALID_RESPONSE", `Response validation failed for ${path}`);
      captureException(validationErr, {
        path,
        issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      throw validationErr;
    }
    return { ...json, data: result.data };
  }

  return json;
}

// ─── Session Auth ────────────────────────────────────────────

let sessionTokenGetter: (() => string | null) | null = null;

export function setSessionTokenGetter(getter: () => string | null): void {
  sessionTokenGetter = getter;
}

export async function authenticatedRequest<T>(
  path: string,
  init?: RequestInit,
  schema?: z.ZodType<T>,
): Promise<ApiResponse<T>> {
  const token = sessionTokenGetter?.();
  if (!token) throw new ApiRequestError("UNAUTHORIZED", "Not logged in");
  return request<T>(path, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  }, schema);
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== ""
  );
  if (entries.length === 0) return "";
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  return `?${qs}`;
}

export async function fetchPapers(params: PaperListParams = {}): Promise<ApiResponse<PaperSummary[]>> {
  const query = buildQuery(params as unknown as Record<string, string | number | boolean | undefined>);
  return request<PaperSummary[]>(`/api/papers${query}`);
}

export async function fetchPaper(author: string, permlink: string): Promise<ApiResponse<PaperDetail>> {
  return request<PaperDetail>(`/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}`, undefined, PaperDetailSchema);
}

export async function fetchPaperEnrichment(author: string, permlink: string): Promise<ApiResponse<{ net_votes: number; reviews: PaperDetail["reviews"]; citation_count: number; is_accredited: boolean }>> {
  return request(`/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/enrichment`);
}

export async function fetchProfile(username: string): Promise<ApiResponse<Profile>> {
  return request<Profile>(`/api/profile/${encodeURIComponent(username)}`, undefined, ProfileSchema);
}

export interface ProfilePapersParams {
  sort?: 'date' | 'votes';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export async function fetchProfilePapers(
  username: string,
  params: ProfilePapersParams = {}
): Promise<ApiResponse<PaperSummary[]>> {
  const query = buildQuery(params as Record<string, string | number | boolean | undefined>);
  return request<PaperSummary[]>(`/api/profile/${encodeURIComponent(username)}/papers${query}`);
}

export async function fetchDisciplines(): Promise<ApiResponse<Discipline[]>> {
  return request<Discipline[]>("/api/disciplines");
}

export async function searchPapers(params: SearchParams): Promise<ApiResponse<SearchResult[]>> {
  const query = buildQuery(params as unknown as Record<string, string | number | boolean | undefined>);
  return request<SearchResult[]>(`/api/search${query}`);
}

export async function uploadToIpfs(
  file: File,
): Promise<ApiResponse<IpfsUploadResponse>> {
  const formData = new FormData();
  formData.append("file", file);

  return authenticatedRequest<IpfsUploadResponse>("/api/ipfs/upload", {
    method: "POST",
    body: formData,
  });
}

export async function requestAccreditation(
  data: Omit<AccreditationRequest, "signed_message" | "hive_username">,
): Promise<ApiResponse<AccreditationRequestResponse>> {
  return authenticatedRequest<AccreditationRequestResponse>("/api/accreditation/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
}

export async function verifyAccreditation(
  token: string
): Promise<ApiResponse<AccreditationVerifyResponse>> {
  return request<AccreditationVerifyResponse>("/api/accreditation/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }, AccreditationVerifySchema);
}

export async function submitAnonymousReview(
  data: AnonymousReviewRequest,
): Promise<ApiResponse<AnonymousReviewResponse>> {
  return authenticatedRequest<AnonymousReviewResponse>("/api/reviews/anonymous", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
}

// ─── Discussion Comments ────────────────────────────────────────

export async function fetchPaperComments(
  author: string,
  permlink: string,
  params: { accredited_only?: boolean; page?: number; limit?: number } = {}
): Promise<ApiResponse<DiscussionComment[]>> {
  const query = buildQuery(params as Record<string, string | number | boolean | undefined>);
  return request<DiscussionComment[]>(
    `/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/comments${query}`
  );
}

// ─── Web of Trust (WoT) ─────────────────────────────────────────

export async function fetchVouchStatus(
  username: string
): Promise<ApiResponse<VouchStatus>> {
  return request<VouchStatus>(
    `/api/wot/${encodeURIComponent(username)}`,
    undefined,
    VouchStatusSchema,
  );
}

export async function notifyVouch(
  vouchee: string,
): Promise<ApiResponse<{ message: string; accredited: boolean; tx_id: string | null; vouch_status: VouchStatus }>> {
  return authenticatedRequest(`/api/wot/vouch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ vouchee }),
  });
}

export async function notifyRetractVouch(
  vouchee: string,
): Promise<ApiResponse<{ message: string; revocations: string[]; vouch_status: VouchStatus }>> {
  return authenticatedRequest(`/api/wot/retract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ vouchee }),
  });
}

// ─── Notifications ──────────────────────────────────────────────

export async function fetchNotifications(
  sinceBlock: number,
  limit = 50,
): Promise<ApiResponse<NotificationBatch>> {
  const query = buildQuery({ since_block: sinceBlock, limit });
  return authenticatedRequest<NotificationBatch>(`/api/notifications${query}`, undefined, NotificationBatchSchema);
}

// ─── Citations ──────────────────────────────────────────────────

export async function fetchPaperCitations(
  author: string,
  permlink: string,
  params: { page?: number; limit?: number } = {}
): Promise<ApiResponse<PaperSummary[]>> {
  const query = buildQuery(params as Record<string, string | number | boolean | undefined>);
  return request<PaperSummary[]>(
    `/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/citations${query}`
  );
}

// ─── Reviews ────────────────────────────────────────────────────

export async function fetchReview(
  author: string,
  permlink: string
): Promise<ApiResponse<ReviewDetail>> {
  return request<ReviewDetail>(
    `/api/reviews/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}`,
    undefined,
    ReviewDetailSchema,
  );
}

// ─── Accreditations ─────────────────────────────────────────────

export async function fetchAccreditations(
  params: { field?: string; institution?: string; page?: number; limit?: number } = {}
): Promise<ApiResponse<AccreditedResearcher[]>> {
  const query = buildQuery(params as Record<string, string | number | boolean | undefined>);
  return request<AccreditedResearcher[]>(`/api/accreditations${query}`);
}

export async function fetchAccreditationStatus(
  username: string
): Promise<ApiResponse<AccreditationStatus>> {
  return request<AccreditationStatus>(
    `/api/accreditations/${encodeURIComponent(username)}`,
    undefined,
    AccreditationStatusSchema,
  );
}

// ─── Platform Stats & Health ────────────────────────────────────

export async function fetchPlatformStats(): Promise<ApiResponse<PlatformStats>> {
  return request<PlatformStats>("/api/stats");
}

// ─── ORCID Verification ──────────────────────────────────────

export async function startOrcidVerification(): Promise<OrcidStartResponse> {
  const res = await authenticatedRequest<OrcidStartResponse>(
    `/api/accreditation/orcid/start`,
  );
  return res.data;
}

export async function completeOrcidVerification(
  code: string,
  state: string,
): Promise<ApiResponse<{ message: string; username: string; orcid: string; tx_id: string }>> {
  return authenticatedRequest(`/api/accreditation/orcid/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code, state }),
  });
}

// ─── Citation Export ─────────────────────────────────────────

export async function fetchCitationExport(
  author: string,
  permlink: string,
  format: CitationFormat
): Promise<CitationExportResponse> {
  const res = await request<CitationExportResponse>(
    `/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/cite?format=${format}`
  );
  return res.data;
}

// ─── Paper Retraction ────────────────────────────────────────

export async function retractPaper(
  author: string,
  permlink: string,
  reason: string,
): Promise<RetractPaperResponse> {
  const res = await authenticatedRequest<RetractPaperResponse>(
    `/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/retract`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason }),
    }
  );
  return res.data;
}

// ─── DOI ─────────────────────────────────────────────────────

export async function fetchDoi(
  author: string,
  permlink: string,
): Promise<DoiResponse> {
  const res = await request<DoiResponse>(
    `/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/doi`
  );
  return res.data;
}

export async function assignDoi(
  author: string,
  permlink: string,
): Promise<DoiResponse> {
  const res = await authenticatedRequest<DoiResponse>(
    `/api/papers/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}/doi?assign=true`,
  );
  return res.data;
}

// ─── Notification Preferences ────────────────────────────────

export async function fetchNotificationPreferences(
  username: string,
): Promise<NotificationPreferences> {
  const res = await authenticatedRequest<NotificationPreferences>(
    `/api/profile/${encodeURIComponent(username)}/notification-preferences`,
  );
  return res.data;
}

export async function updateNotificationPreferences(
  username: string,
  prefs: { email_digest: boolean; digest_frequency: DigestFrequency; email: string | null },
): Promise<NotificationPreferences> {
  const res = await authenticatedRequest<NotificationPreferences>(
    `/api/profile/${encodeURIComponent(username)}/notification-preferences`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(prefs),
    }
  );
  return res.data;
}

// ─── Preprint Bridge ────────────────────────────────────────

export async function fetchBridgeLookup(
  identifier: string,
): Promise<ApiResponse<BridgeLookupResult>> {
  return request<BridgeLookupResult>(
    `/api/bridge/lookup${buildQuery({ identifier })}`,
  );
}

export async function fetchBridgeCheck(
  identifier: string,
): Promise<ApiResponse<BridgeCheckResult>> {
  return request<BridgeCheckResult>(
    `/api/bridge/check${buildQuery({ identifier })}`,
  );
}

export async function registerBridgePaper(
  data: { identifier: string; discipline: string; keywords?: string[]; language?: string },
): Promise<ApiResponse<RegisterBridgePaperResponse>> {
  return authenticatedRequest<RegisterBridgePaperResponse>("/api/bridge/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
}

export async function updateBridgePaper(
  permlink: string,
): Promise<ApiResponse<UpdateBridgePaperResponse>> {
  return authenticatedRequest<UpdateBridgePaperResponse>("/api/bridge/update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ permlink }),
  });
}

export async function submitContactForm(
  data: ContactSubmission,
): Promise<ApiResponse<{ message: string }>> {
  return request<{ message: string }>("/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function fetchHealth(): Promise<HealthCheckResponse> {
  const url = `${BASE_URL}/api/health`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new ApiRequestError("HEALTH_CHECK_FAILED", `Health check failed with status ${res.status}`);
  }
  return res.json();
}

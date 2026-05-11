# PEvO API Contract — Misc

Blog, contact form, disciplines, stats, and health check endpoints.

---

### GET /api/blog

List blog posts. Returns posts by the configured blog author under the blog tag. Not paginated (returns all matching posts up to `limit`). Rate-limited.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 20 | Max posts to return (1–20, capped by Hive API) |

**Response:**

```json
{
  "status": "ok",
  "data": [
    {
      "author": "pevo.science",
      "permlink": "welcome-to-pevo",
      "title": "Welcome to PEvO",
      "body": "Full Markdown body...",
      "created": "2026-04-15T10:00:00",
      "tags": ["pevo-blog", "announcement"]
    }
  ]
}
```

---

### GET /api/blog/:permlink

Fetch a single blog post by permlink. Returns 404 if the post does not exist or does not belong to the blog.

**Path Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `permlink` | string | Post permlink |

**Response:**

```json
{
  "status": "ok",
  "data": {
    "author": "pevo.science",
    "permlink": "welcome-to-pevo",
    "title": "Welcome to PEvO",
    "body": "Full Markdown body...",
    "created": "2026-04-15T10:00:00",
    "tags": ["pevo-blog", "announcement"]
  }
}
```

**Errors:**

| Code | Status | When |
|------|--------|------|
| `NOT_FOUND` | 404 | Permlink not found or not a blog post |

---

### POST /api/contact

Submit a contact form message. Sends an email to the configured admin address.

**Body:**

```json
{
  "category": "bug",
  "email": "user@example.com",
  "subject": "Issue with paper submission",
  "message": "Detailed description..."
}
```

Valid categories: `bug`, `accreditation`, `keychain`, `general`.

**Response `data`:**

```json
{
  "message": "sent"
}
```

**Rate limit:** 5 requests per IP per hour.

**Errors:**
- `VALIDATION_ERROR` — missing or invalid fields

---

### GET /api/disciplines

List all disciplines that have at least one PEvO paper, deduped case-insensitively.

Discipline names are user-authored strings in `json_metadata.discipline`, so mixed-case entries ("Physics" vs "physics") previously produced duplicate dropdown rows. The HAF query groups by `LOWER(name)` and returns one row per canonical (lowercase) discipline.

**Response `data`:** Array of `Discipline`

```json
{
  "canon_name": "neuroscience",
  "display_name": "Neuroscience",
  "paper_count": 42
}
```

- `canon_name` — lowercase canonical value. Use this as the URL value for `?discipline=<canon_name>` filters (the backend lowercases the incoming filter too, so mixed-case still matches, but passing `canon_name` keeps URLs stable).
- `display_name` — one representative casing from the underlying rows (the `MAX(name)` of the group, which is deterministic-but-arbitrary). The frontend is expected to titlecase or otherwise normalize this for rendering.
- `paper_count` — total papers across all casings of this discipline.

**Discipline filter semantics (`?discipline=` on `/api/search` and `/api/papers`):** the match is case-insensitive. `?discipline=physics` matches papers tagged "Physics", "PHYSICS", "physics", etc. This applies on `/api/papers` as well as `/api/search`; both lowercase the query-parameter and the SQL column under `LOWER()` to match the `/api/disciplines` canon_name semantics.

---

### GET /api/stats

Platform-wide statistics.

**Response `data`:**

```json
{
  "total_papers": 256,
  "total_reviews": 812,
  "total_accredited_researchers": 89,
  "total_citations": 1043,
  "active_disciplines": 15,
  "papers_last_30_days": 23,
  "reviews_last_30_days": 67,
  "total_bridge_papers": 42,
  "highest_reputation_user": "scientist1",
  "highest_reputation_score": 95
}
```

**Field notes:**

- `active_disciplines`: count of distinct lowercase-canonical discipline strings (`count(DISTINCT LOWER(json_metadata -> appTag ->> 'discipline'))`). Case-insensitive dedup matches the `/api/disciplines` canon_name grouping. This semantic changed from case-sensitive `DISTINCT` in BE-DISCIPLINE-CANONICALIZE; the number may step down on first deploy against any corpus with mixed-case discipline variants (e.g. "Physics" and "physics" previously counted as 2, now count as 1).
- `active_disciplines` counts **only papers authored by currently-accredited researchers** (the `papers` CTE filters via `active_accreditations`), while `/api/disciplines` counts **all** PEvO-tagged papers regardless of accreditation status. The two endpoints count from different sets; `active_disciplines` may be smaller than `/api/disciplines.data.length`. This divergence is intentional per the accredited-only data policy in `ARCHITECTURE.md`.

---

### GET /api/health

Server health check. Not paginated.

**Response:**

```json
{
  "status": "ok",
  "haf_available": true,
  "redis_available": true,
  "timestamp": "2026-03-25T12:00:00Z"
}
```

**Field notes:**

- `haf_available` reflects whether HAF is **configured** in this deployment (i.e., `HAF_DATABASE_URL` is set), NOT whether HAF is currently reachable. A live-unreachable but configured HAF still shows `true`. The wire field name is preserved for backward compatibility; the underlying backend helper is `isHafConfigured()`. Status-page consumers should treat this as a "feature available in this deployment" signal, not a real-time health check. A future contract revision MAY introduce a separate live-reachability field if needed; deployments needing a real-time signal today should probe a HAF-backed endpoint directly (e.g., `GET /api/disciplines`).
- `redis_available` reflects whether the Redis ping at request time succeeded. This IS a real-time check; a transient Redis outage flips the field to `false`.

Note: This endpoint does not use the standard response envelope.

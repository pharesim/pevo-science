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

List all disciplines that have at least one PEvO paper.

**Response `data`:** Array of `Discipline`

```json
{
  "name": "neuroscience",
  "paper_count": 42
}
```

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

Note: This endpoint does not use the standard response envelope.

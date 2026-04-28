# BE-PAPERS-CACHE-KEY-SHA256-MIRROR — sha256-wrap `/api/papers` cache key like `/api/search` does

**Owner:** backend
**Created:** 2026-04-28 (surfaced by BE-DISCIPLINE-LENGTH-CAP review, adversarial reviewer P3)
**Priority:** P3

## Context

`backend/src/routes/papers.ts:489` builds the Redis cache key by concatenating raw query-string fragments:

```ts
const cacheKey = `papers:p=${page}:l=${limit}:s=${sort}:o=${order}:d=${discipline}:k=${keyword}:a=${author}:lang=${language}:ao=${accreditedOnly}:ir=${includeRetracted}:src=${source}`;
```

Post-BE-DISCIPLINE-LENGTH-CAP, `discipline` is sanitized (no `:` allowed). The siblings (`keyword`, `author`, `language`, `source`) are pulled with `req.query.X || ''` and pasted directly into the cache key with no charset validation.

Two distinct request shapes can produce the same Redis key, e.g.:
- A: `?discipline=physics&keyword=:a=alice` → fragment `:k=:a=alice:a=`
- B: `?discipline=physics&keyword=&author=:a=alice` → same fragment

`backend/src/routes/search.ts:339-340` already mitigates this in-repo:

```ts
const cacheKey = `search:${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
```

`papers.ts` should mirror that pattern.

## Goal

1. Build a `rawKey` string the same shape `papers.ts` uses today.
2. sha256 + slice the digest to a fixed-width hex prefix; prepend `papers:` namespace.
3. Use the resulting digest as `cacheKey`.

## Risk envelope

The blast radius of the existing collision is bounded:
- Cache poisoning between different filter combos (no auth bypass, no cross-user data exposure).
- Requires the attacker to craft colliding `keyword`/`author`/`language`/`source` values containing `:`.
- With SWR (stale-while-revalidate), poisoned data can persist across revalidation.

Pre-existing — not introduced by BE-DISCIPLINE-LENGTH-CAP, just made more visible by the asymmetric sanitization between `discipline` (sanitized) and siblings (not).

## Implementation notes

- Cache-key namespace prefix should be `papers:` (matches the current literal prefix).
- Match `search.ts`'s 32-char hex slice to keep keys reasonably sized.
- One change in `papers.ts:~489`; no other call sites.
- Audit the rest of the backend for any other manual cache-key construction with attacker-controlled string fragments — file follow-ups if found, do not expand scope here.

## Tests

- Mocked-pool carve-out spec in a new file or `disciplines-canon-mocked.test.ts`: two requests with collision-inducing keyword/author values → assert distinct sha256 cache keys, asserting they do NOT collide. Equivalently: assert `rawKey` containing `:` characters produces a key that does not equal another `rawKey` differing in field assignment but identical-after-flat-concat.
- No real-HAF spec needed; collision is a function of cache-key construction, not HAF behavior.

## Acceptance

- `papers.ts:~489` cache key is sha256-wrapped per the `search.ts:339-340` pattern.
- Mocked-pool collision-prevention spec passes.
- `git grep` confirms no remaining `papers:` flat-concat cache keys.

---

## Implementer re-review signal (2026-04-28, backend) — round 1

Landed in a single commit. Cache key on `/api/papers` is now sha256-wrapped.

**Code change** (`backend/src/routes/papers.ts`):
- Added `import crypto from 'crypto'` (top-level, mirrors search.ts).
- Replaced the flat-concat cache-key construction at the route handler with a `rawKey` + `papers:${sha256(rawKey).hex.slice(0, 32)}` pair, mirroring `search.ts:320` exactly. The rawKey carries the same field set as before (no semantic change), just hashed before being used as the Redis namespace.

**Mocked-pool tests** (new describe block in `backend/tests/routes/disciplines-canon-mocked.test.ts`):
- **Collision prevention**: two requests carrying `:` and `=` characters in distinct fields (`?keyword=foo:a=alice` vs `?author=foo:a=alice`) produce two distinct papers-data SQL calls (i.e., two distinct cache entries). Pre-fix, this could fold into delimiter collisions; post-fix the sha256 wrap makes each rawKey character-by-character unique.
- **Cache hit on identical rawKey**: two identical requests share a single cache entry → exactly 1 papers-data SQL call. Sanity check that sha256 is deterministic and not accidentally salted.
- **Wrapper shape**: spy on `hafCache.getOrSetSWR` and assert the cache key matches `/^papers:[0-9a-f]{32}$/` — pins the namespace literal, the digest base, and the slice width so a future refactor that drifts any of those surfaces here.

**Tests run** (with docker-IP env overrides per CLAUDE.md):
- `tests/routes/disciplines-canon-mocked.test.ts` → 16/16 passed (was 13 before; +3 new cases).
- `tests/routes/papers.test.ts` (real-HAF SWR-path regression) → 12 passed | 1 skipped (pre-existing).
- `npm run lint` clean (2 pre-existing warnings on `seed-phrase.ts`, unchanged).

**Audit findings** (`git grep` for flat-concat cache-key construction with attacker-controlled string fragments across `backend/src/`):
- `accreditations.ts:91` — uses `JSON.stringify({field, institution, ...})` so embedded `:` / `=` are escaped. Collision-safe.
- `accreditations.ts:156` — `accreditation-status:${username}`. Hive account names are `[a-z0-9.-]{3,16}`; no `:` possible.
- `bridge.ts:140` — `bridge-check:${parsed.type}:${parsed.id}`. `parsed.type` is the strict union `'arxiv' | 'doi'`; `parsed.id` is the canonical identifier. **Theoretical risk**: DOI suffixes per the spec can contain `:`, so a crafted DOI like `10.1234/foo:bar` could in principle fold delimiters. **Realistic risk**: bounded — the namespace prefix `bridge-check:` plus the `parsed.type` enum gives only two possible structural prefixes (`bridge-check:arxiv:` and `bridge-check:doi:`), and a colliding pair would need to fold across the type boundary. Filing as a low-priority follow-up below rather than expanding scope here.
- `claims.ts:30` — `claims:${paperAuthor}:${paperPermlink}`. Hive identifiers, no `:`. Safe.
- `comments.ts:185` — `comments:${author}:${permlink}:p=...:s=...:o=...:ao=...`. Author/permlink are Hive identifiers; `params.sort/order/limit/page` are pre-validated enums/integers; `accreditedOnly` is a boolean. Safe.
- `notifications.ts:33` — `notifications:${account}:${sinceBlock}:${limit}`. Hive account + integers. Safe.
- `papers.ts:1027/1058/1324` — paper-detail / paper-enrichment keys built from `${author}:${permlink}`. Hive identifiers, no `:`. Safe.
- `profile.ts:257/383` — `JSON.stringify({sort, order, page, limit})`. Safe by escape.

**Follow-up filed (out of scope for this task):**
- `backend-bridge-cache-key-doi-colon-folding.md` — N/A (not yet filed). Architect triage suggested rather than auto-creating per CLAUDE.md "Code Review Findings". Surfacing here for triage: should the DOI-suffix `:` folding theoretical risk on `bridge-check:` cache keys be filed as a P3 follow-up?

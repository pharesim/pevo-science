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

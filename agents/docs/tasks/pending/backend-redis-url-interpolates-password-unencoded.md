# Percent-encode REDIS_PASSWORD before composing redisUrl

**Owner:** backend
**Created:** 2026-09-22

Filed by the ui agent at the user's request, after an E2E harness review surfaced the
frontend half and tracing the root cause landed in backend config.

## Why

`config.redisUrl` in `backend/src/config.ts` composes the URL by interpolating
`REDIS_PASSWORD` directly:

```
redisUrl: process.env.REDIS_URL ||
  (process.env.REDIS_PASSWORD ? `redis://:${process.env.REDIS_PASSWORD}@redis:6379` : ''),
```

Nothing percent-encodes the password. `ioredis` parses the result with Node's legacy
`url.parse`, so a password containing a URL-significant character does not fail: it
misparses, and the client is built from the wrong pieces.

Reproduced on this host with ioredis 5.10.1 and node v20.20.2, synthetic passwords only.
For `redis://:AAA#BBB@redis:6379`:

| parsed field | value |
|---|---|
| host | `"localhost"` (not `redis`) |
| port | 6379 |
| password | `null` |
| username | `null` |

So a `#` in the password silently drops authentication entirely and redirects the host.
Inside the backend container this fails closed, because nothing listens on
`localhost:6379` there, so the symptom is a connection refusal that names the wrong host
and never mentions the password as the cause. A host-side process composing the same way
can reach a real Redis with no auth.

Separately, every malformed shape emits a Node deprecation warning that prints the entire
connection string, password included, to stderr:

```
[DEP0170] DeprecationWarning: The URL redis://:<password>@127.0.0.1:not-a-port is invalid.
```

That warning is emitted from inside the `new Redis(...)` constructor, so it cannot be
caught by a surrounding try/catch, and it reaches operator logs with the live
`REDIS_PASSWORD` in cleartext. A password containing `@` happens to parse correctly
(the last `@` wins), so the failure is character-dependent and will not show up until
someone rotates to a password with `#`, `/`, `?`, or a space.

Node's own message says future versions will throw rather than warn, so the misparse
shapes become hard failures on a future runtime upgrade.

## Scope

1. Percent-encode the password when composing `config.redisUrl`, e.g.
   `encodeURIComponent(process.env.REDIS_PASSWORD)`. Check whether any other composed
   URL in `backend/src/config.ts` interpolates a secret or operator-supplied value the
   same way and fix those together.
2. Decide whether `getRedis()` in `backend/src/redis.ts` should also pass the password
   via the `password` option instead of embedding it in the URL, which sidesteps URL
   parsing for the credential entirely. Prefer that if it does not disturb the
   `REDIS_URL`-override path, since it removes the class rather than escaping around it.
3. The frontend E2E harness has the same constructor shape in `global-setup.js`
   (`resetRateLimitKeys`) and `global-teardown.js` (`cleanupIpfsPins`), reading an
   operator-written `REDIS_URL` from `frontend/.env.test`. Those take a whole URL rather
   than composing one, so encoding is the writer's job there, not the reader's. Worth a
   note in `frontend/.env.test.example` telling the writer to percent-encode a password
   containing URL-significant characters. That file and both harness hooks are ui zone,
   so either hand that piece to ui or let the architect split it into its own task.

## Acceptance criteria

1. With `REDIS_PASSWORD` set to a value containing `#`, the composed `config.redisUrl`
   yields a client whose parsed host is the intended one and whose password is non-null.
2. No code path prints the password. Specifically, constructing the client with such a
   password emits no DEP0170 warning naming the connection string.
3. The existing `REDIS_URL`-override path still wins over the composed form.

## Notes

- Not introduced by recent work. The composition predates the E2E loopback changes and
  is unchanged by them; the review that surfaced it correctly scoped it out of that
  commit.
- The current local `REDIS_PASSWORD` is alphanumeric, so nothing is broken today. This is
  a latent trap that arms itself on the next password rotation.
- Verification must use a synthetic password. Do not echo the real one into a terminal or
  a test fixture.

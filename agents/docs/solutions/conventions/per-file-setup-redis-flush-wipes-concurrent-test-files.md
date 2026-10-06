---
title: tests/setup.ts flushes the appTag Redis namespace at the start of every test file, so concurrent files and concurrent runs wipe each other's keys
date: 2026-10-06
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Reading a red bar from one vitest invocation that ran more than one backend test file"
  - "Writing a backend test that seeds Redis state (a token, a limiter bucket, a batch cursor or lock) and reads it back after an await"
  - "Building a scratchpad probe or mutation copy of backend/ that runs vitest"
  - "Running backend tests while another session may be running them against the same Redis DB"
related_components:
  - redis
tags:
  - vitest
  - test-isolation
  - redis
  - parallel-workers
  - cross-file-contamination
  - setup-files
---

# tests/setup.ts flushes the appTag Redis namespace at the start of every test file, so concurrent files and concurrent runs wipe each other's keys

## Context

`backend/vitest.config.ts` lists `backend/tests/setup.ts` under `setupFiles` and sets `maxWorkers: 2`. Vitest runs a `setupFiles` entry inside every test file, before that file's tests; only `globalSetup` runs once per run. The `beforeAll` in `backend/tests/setup.ts` pings Redis, runs ``redis.keys(`${config.appTag}:*`)``, deletes every match, and reloads the Lua scripts. So the flush is not a once-per-run reset. Each file start, in either worker, is a wildcard delete over the namespace every other test file writes into.

The setup file's docblock opens "Global test setup — runs before/after all test files", which reads like `globalSetup` and hides the per-file timing. A scratchpad probe (two workers, a setup file that logs its flush, one file holding a key across a 3 s await) showed the sibling file's flush landing mid-await: the held key read `exists() = 0`, and the same files passed with `--maxWorkers=1`.

The hazard is known in pieces but had no single home. Test comments name it where it bit: `fresh-auth-consent-op-burn-offline-queue.test.ts` ("a sibling worker's per-file keyspace flush"), `_getSpentConsentOpsSizeForTests` in `backend/src/lib/fresh-auth.ts` ("a sibling test file's keyspace flush"), and `reputation-batch-sql-failure.test.ts` ("or its setup flush", with a `{ retry: 5 }` budget). Earlier sessions reported it in task signal blocks as an out-of-scope flake risk and left it unfixed (session history).

## Guidance

- **Treat every test file start as a `KEYS` + `DEL` over shared Redis.** State a test seeds in Redis and reads back after an await can vanish when another file starts in the other worker: verification tokens, rate-limit buckets, batch cursors and locks, replay guards, cached receipts.
- **Every added test file adds a flush event,** including a pure schema test that never touches Redis, because the setup file runs for it too.
- **Another vitest run against the same Redis DB has the same effect.** That includes another agent's session and a full-suite run in the background. The root CLAUDE.md test command targets DB 0, which is also the dev deployment's DB (`docker-compose.yml` gives the backend `redis:6379` with no DB index, under the same `APP_TAG`), so a test run also wipes the dev server's live `${APP_TAG}:*` keys.
- **For a result you will rely on, run the Redis-holding file in its own vitest invocation with `--retry=0`,** and compare it with the same file run alone on the parent commit. A multi-file invocation's red bar is not evidence about any single file.
- **Give a probe or mutation copy its own Redis DB index.** Point `REDIS_URL` at `redis://:<password>@<redis-ip>:6379/N`, one `N` per concurrent prober. ioredis honours the `/N` path, so the copy's per-file flush stays inside DB `N` and never reaches DB 0. One file ignores the index: `fresh-auth-consent-op-burn-offline-queue.test.ts` builds its own clients from the URL's host, port and password, so its keys stay in DB 0.
- **Name a cause from the failure messages, not the count.** A burst of failures in a multi-file run can come from this flush, from HAF pool starvation, or from a sibling's stack restart that swaps the Postgres and Redis container IPs mid-run (the run keeps the IPs it resolved at start). Re-run the file alone and read the errors before attributing.

No structural fix is filed: moving the flush into a `globalSetup`, or giving each worker its own DB index or key prefix. Until one lands, `retry: 3` in `vitest.config.ts` and per-spec retry budgets absorb part of this contention, and also hide it.

## Why This Matters

A flush-induced failure lands in the file that did not flush, shifts between runs, and usually passes on retry, so it reads as load noise or as a regression in whatever changed last. Without this rule an implementer chases phantom red bars from multi-file runs, or trusts a green that only held because no sibling file started at the wrong moment. A probe copy that isolates the files but shares DB 0 silently flushes the keys of every other run on the box.

## When to Apply

- Before reporting any backend test result as a regression or as green: was it a single-file invocation?
- When a test seeds Redis and asserts on it after an await, especially one that awaits a real HAF query.
- When setting up concurrent probe copies of `backend/`.

## Examples

One file alone, with the root CLAUDE.md environment:

```bash
REDIS_URL="redis://:$(grep REDIS_PASSWORD .env | cut -d= -f2)@$(docker inspect pevo-redis-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):6379" \
APP_DATABASE_URL="postgresql://pevo:pevo_dev@$(docker inspect pevo-postgres-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):5432/pevo_app" \
npx vitest run --retry=0 tests/routes/accreditation.test.ts
```

A probe copy on its own DB (index 7 here):

```bash
export REDIS_URL="redis://:$(grep ^REDIS_PASSWORD= /home/micha/workspace/pevo/.env | cut -d= -f2)@<redis-ip>:6379/7"
```

## Related

- `agents/docs/solutions/conventions/test-teardown-wildcard-delete-shared-id-band-parallel-workers-2026-06-14.md`: the same wildcard delete over a namespace concurrent files share, on Postgres rows in teardown hooks.
- `agents/docs/solutions/conventions/cross-file-singleton-redis-key-test-isolation-2026-06-15.md`: a singleton Redis key read and written during execution. Its read-pin does not cover the per-file flush.
- `agents/docs/solutions/conventions/parallel-probe-fanout-needs-per-run-artifact-paths-2026-09-22.md`: scope every shared name concurrent workers touch. The per-prober Redis DB index is that rule applied to Redis.

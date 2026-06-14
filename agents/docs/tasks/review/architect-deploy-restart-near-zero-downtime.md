# deploy.sh restart: collapse the multi-minute 502 to a few-second swap

**Owner:** architect
**Created:** 2026-06-14

`./deploy.sh restart` currently serves an HTTP 502 for the **entire** rebuild
(minutes), not just a brief blip. Goal: rebuild + deploy the running app while host
nginx keeps getting a live upstream, so the outage drops from minutes to a
few-second swap.

**Scope decision (user, 2026-06-14): Tier 1 — near-zero, deploy.sh-only reorder.**
True zero-downtime (an internal proxy container, or a host-nginx upstream flip) was
considered and explicitly deferred — it needs backend chain-safety code and either a
new permanent service or a root sudoers grant. See "Deferred / out of scope" below.
This task does NOT reach literal zero; it removes the multi-minute outage and leaves
a bounded ~2-8s swap blip, which is the floor for a single host port behind an
unreloadable host nginx.

## Root cause

`cmd_restart` runs `$COMPOSE down` as its first step. That stops the backend (and
infra) before the new image is even built, so `127.0.0.1:3001` has no listener for
the whole `down → build → infra-up → migrate → backend-boot` sequence. Host nginx
(on the host, root-managed, external, proxies all traffic straight to
`127.0.0.1:3001`) gets ECONNREFUSED and returns 502 the entire time. The image build
(frontend Vite + backend `tsc` + the swot academic-domain git clone) is the dominant
cost and is paid entirely while the backend is down.

## Approach (Tier 1): build first, keep infra up, swap only the backend last

Rewrite `cmd_restart` so nothing that is serving is ever torn down. The backend
already has graceful SIGTERM shutdown (drains the argon2 queue, `server.close()` up to
30s, closes pools/redis) and a real `/api/health`, so a stop-then-start swap of just
the backend container is safe. Target sequence:

1. **Build first, with the old backend still serving.** Run the build before
   touching anything: `DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 $COMPOSE build backend`
   (only the backend service has a `build:`; infra images are pinned). The
   minutes-long build now contributes **zero** downtime. Remove the leading
   `$COMPOSE down` entirely — it is the single line that causes the multi-minute 502.
2. **Ensure infra is up (idempotent), never down it.** Keep the existing
   `$COMPOSE $COMPOSE_FILES up -d postgres redis ipfs` + `pg_isready` wait. These
   no-op when infra is already healthy. (Keep `$COMPOSE_FILES` threaded so the
   journald logging overlay still applies at container-create time.)
3. **Migration safety pre-flight, then migrate live.** With the old backend still
   serving, the DB briefly runs ahead of it. That is safe for the current migration
   set, but must be **gated**, not assumed (see "Migration safety" below). Run a
   destructive-DDL grep over `backend/migrations/*.sql`; if clean, `cmd_migrate` live;
   if a destructive token matches, fall through to the brief-stop carve-out
   (`$COMPOSE stop backend` → migrate against the quiescent DB → start new backend).
4. **Swap only the backend, last.** Recreate just the backend with
   `$COMPOSE $COMPOSE_FILES up -d --no-deps backend`. Compose SIGTERMs the old
   container (graceful drain) and starts the new one. The 502 window collapses to this
   one container's swap.

## Verification-driven corrections (must apply — these were found by adversarially stress-testing the naive reorder)

- **Use `--no-deps` and DROP `--remove-orphans` on the backend swap step.** The
  current swap goes through `cmd_up backend`, which runs `up -d --remove-orphans backend`.
  Two problems: (a) `--remove-orphans` reaps the E2E sidecars (mailpit, orcid-stub,
  orcid-works-stub from `docker-compose.test.override.yml`) if a `test-up` session is
  live; (b) `depends_on: condition: service_healthy` is re-evaluated and can stall the
  swap if an infra container is mid-healthcheck-cycle. `--no-deps` skips the dep gate
  (infra is already up and we already waited `pg_isready`); dropping `--remove-orphans`
  on the swap avoids the sidecar reap. Do this with a dedicated swap path, not by
  routing through the shared `cmd_up`.
- **The reused health-wait probes INSIDE the container and is blind to the host-port
  rebind.** `cmd_up`'s loop runs `$COMPOSE exec -T backend wget … localhost:3001/api/health`,
  which passes the instant the *new container's* Node process listens — it says nothing
  about whether the host-side docker-proxy has rebound `127.0.0.1:3001`. For the swap,
  poll the host side instead (`curl/wget http://127.0.0.1:3001/api/health` from the
  host) so the script observes the real readiness. This is observability, not a fix for
  the gap.
- **`stop_grace_period` (compose default 10s) vs `server.close()` 30s mismatch.** An
  in-flight IPFS download holds a connection open; `server.close()` won't return, and
  Docker SIGKILLs the old container at 10s, truncating the drain. Consider setting
  `stop_grace_period: 35s` on the backend service in `docker-compose.yml` so the
  graceful drain isn't cut off mid-flight. Optional correctness footnote, not a 502
  cause on its own.

## Migration safety (the rule the live-migrate path depends on)

`verifyAppDbMigrations` (`backend/src/app-db.ts`) fails **closed only when the DB is
BEHIND the code** (a `*.sql` on disk lacks its `schema_migrations` row); it tolerates
the DB being **AHEAD** of the still-running old backend (extra rows ignored). That
asymmetry is exactly what makes migrate-before-swap safe — the old backend's probe
already passed at its own boot and is not re-run. The current set is expand-only
(14/16 pure `ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX` / `COMMENT`; the two
`ALTER … DROP NOT NULL` only relax constraints; the one new column carries
`DEFAULT now()`). The only shapes that would break a still-serving old backend are
relation/column removal or rename, a type change, or `ADD COLUMN … NOT NULL` without a
default. So:

- Pre-flight grep the to-be-applied migrations for `DROP TABLE`, `DROP COLUMN`,
  `RENAME`, `ALTER COLUMN … TYPE`, and `ADD COLUMN … NOT NULL` lacking `DEFAULT`.
- Clean → live-migrate then swap. Match → brief-stop carve-out (one container
  stop+start window, not the whole build).
- Document this decision rule in a `cmd_restart` comment AND in `ARCHITECTURE.md`
  (Migrations section) so a future destructive migration does not silently break the
  live-migrate path. Also note the latent foot-gun: a future large-table non-`CONCURRENTLY`
  `CREATE INDEX` / `ALTER … SET NOT NULL` can take `ACCESS EXCLUSIVE` locks that stall
  the still-serving old backend even when the grep passes; negligible at beta row
  counts, prefer `CONCURRENTLY` or the carve-out at scale.

## Why this does NOT reintroduce the singleton-job double-broadcast hazard

The backend runs in-process singleton jobs; two of them broadcast to Hive with no
cross-instance coordination — `startAccountClaimer` (immediate `claim_account` on boot,
no durable cadence gate) and `startBridgeWorker` (5-min chain cooldown enforced only by
in-process state). A blue-green *overlap* would double-fire these. Tier 1 does **not**
introduce that overlap: the swap is stop-then-start, and the new backend only runs the
`start*()` block from inside its `listen()` callback (after its multi-second boot), by
which time Compose has already SIGTERMed the old container and its jobs have stopped. So
at most a sub-second job tail exists — materially identical to today's `down`-based
restart, and far less than a real two-instance overlap. The durable per-job cadence
guards (Redis `SET NX EX 24h` on the claimer; persist the bridge cooldown at broadcast
time / Redis lease; durable digest daily-claim) are **only** needed if a future redesign
adopts true overlap — they are deferred with Tier 2, not part of this task.

## Acceptance criteria

- A `./deploy.sh restart` no longer serves a 502 for the duration of the image build.
  The only client-visible outage is the single backend-container swap, bounded to a
  few seconds (empirically ~2-5s of Docker stop→remove→create→bind port handover plus
  ~1-2s warm boot-to-listen; up to ~10-15s on a cold/loaded HAF node).
- Infra (postgres/redis/ipfs) is never torn down by `restart`; only the backend is
  recreated.
- Migrations apply with the old backend still serving on the clean (expand-only) path;
  a destructive migration triggers the documented brief-stop carve-out.
- The backend swap uses `--no-deps` without `--remove-orphans`; the readiness probe is
  host-side.
- `$COMPOSE_FILES` (journald overlay) stays threaded into both the infra-up and the
  backend swap (container-create calls).
- A `cmd_restart` comment and `ARCHITECTURE.md` (Migrations) document the live-migrate
  decision rule and that the few-second swap blip is the inherent floor for a single
  host port behind an unreloadable host nginx (not a bug).
- Sanity-run `./deploy.sh restart` locally (or confirm the sequence by reading the
  diff) and confirm no infra recreation and a clean backend swap.

## Deferred / out of scope (do NOT bundle into this task)

- **True zero-downtime (Tier 2).** Eliminating the last few seconds needs a
  readiness-gated cutover: either (a) an internal nginx proxy container owning
  `:3001` blue-greening two backend containers, or (b) a host-nginx upstream flip
  (`sed` the upstream + `sudo nginx -s reload`, requires a root sudoers grant + a
  deploy-writable include). **Both** additionally require backend code: a
  `RUN_BACKGROUND_JOBS` boot flag + an extracted/latched `startBackgroundJobs()` + a
  `SIGUSR2`/`SIGHUP` promotion handler, AND the durable cadence guards on the
  account-claimer and bridge-worker described above (these are MANDATORY for Tier 2, not
  optional — the promotion transition re-fires the claimer and re-seeds the bridge
  worker from a query that can miss an unpersisted-but-landed broadcast). File as a
  separate multi-agent (architect + backend) task if pursued.
- **Boot-time HAF-cache optimization.** The residual swap gap is dominated partly by
  two serial cold remote HAF round-trips that block `listen()` — `getGenesisBlock` and
  `startRetractionCache`'s initial reload. Moving both to *after* `listen()`
  (background-warmed like the other caches) would shrink boot-to-listen to ~1-2s, but
  it does NOT shrink the Docker port-handover floor, it is a `backend/` change, and it
  risks routes briefly serving a HEAD-block floor / empty retraction set during the
  warmup window. Separate backend task with route-contract review; not part of this
  reorder.

## Zone note

Tier 1 is deploy-infra only: `deploy.sh` (`cmd_restart`, and a small dedicated swap
helper) plus an optional `docker-compose.yml` `stop_grace_period` and an
`ARCHITECTURE.md` Migrations note — all architect zone. No `backend/` or `frontend/`
changes.

## Implementation (architect, 2026-06-14)

Landed in `architect(deploy): collapse restart 502 to a backend-only swap`.

- `cmd_restart` rewritten: build backend first (old backend still serving),
  ensure infra up idempotently, migration safety pre-flight, swap only the
  backend last via a dedicated `swap_backend` (`up -d --no-deps backend`, no
  `--remove-orphans`, host-side `/api/health` poll).
- `docker-compose.yml`: `stop_grace_period: 35s` on backend (> the 30s
  `setTimeout` force-timeout in `backend/src/index.ts` shutdown).
- `ARCHITECTURE.md` (Migrations): live-migrate decision rule + ungated
  lock-hazard foot-gun + few-second-floor note.

**Verification-driven deviation from the task text (intentional, safe):** the
task said "grep over `backend/migrations/*.sql`". Implemented instead as a grep
over the **UNAPPLIED** set only (`unapplied_migrations` = disk basenames minus
`schema_migrations` rows). Reason: `004_drop_account_creation_tokens.sql` carries
`DROP TABLE IF EXISTS`, so a whole-`*.sql` grep would match on every restart and
force the brief-stop carve-out unconditionally — defeating the "clean path =>
live-migrate" acceptance criterion. The unapplied-set filter is conservative on
uncertainty (missing tracking table / query failure => treat all as unapplied =>
brief-stop). The `ADD COLUMN ... NOT NULL` tripwire over-matches (ignores the
safe `DEFAULT` case and matches comment lines) by design — a false-positive
carve-out costs only a brief stop; a missed destructive migration breaks the
still-serving old backend.

**Verification done:** `bash -n deploy.sh` clean; `docker compose config`
validates with `stop_grace_period: 35s`; destructive-grep regex unit-checked
against all real migrations (matches 004 DROP TABLE + the benign over-matches;
ignores DROP NOT NULL / COMMENT / CREATE INDEX / nullable ADD / SET NOT NULL) and
against synthetic destructive shapes (all four caught). Live `./deploy.sh restart`
NOT run — a sibling was mid-deploy (postgres just recreated, backend absent);
confirmed the sequence by reading the diff per the acceptance escape hatch.

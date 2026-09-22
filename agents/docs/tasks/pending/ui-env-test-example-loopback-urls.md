# Point the .env.test template at the loopback ports

**Owner:** ui
**Created:** 2026-09-22

Filed by the backend agent at the user's request.

## Why

`frontend/.env.test.example` gives `APP_DATABASE_URL` on `localhost:5432` and has no
`REDIS_URL` entry, although `frontend/tests/e2e/global-setup.js` and `global-teardown.js`
read `REDIS_URL` from `frontend/.env.test`. Without it, global setup skips the rate-limit
reset and global teardown skips its Redis cleanup, each with only a warning, so a copy made
from the template runs E2E without either.

`architect-e2e-postgres-redis-loopback-ports` publishes Postgres and Redis on 127.0.0.1
under `./deploy.sh test-up`. Once that lands, the template can name fixed addresses for
both instead of docker-network IPs, which change on every Docker restart.

## Scope

1. Add a `REDIS_URL` entry to `frontend/.env.test.example`, as
   `redis://:<REDIS_PASSWORD from the repo-root .env>@127.0.0.1:6379`, with a comment
   saying it is the dev Redis published on loopback under `./deploy.sh test-up`, and that
   the harness uses it only for the `${APP_TAG}:rl:*` reset in global setup and the
   cleanup in global teardown.
2. Change the `APP_DATABASE_URL` example host from `localhost` to `127.0.0.1`, so both
   entries name the address the override binds.
3. Say in the template's header that both URLs only answer while the stack runs under
   `./deploy.sh test-up`.

## Acceptance criteria

1. The template lists both URLs on 127.0.0.1 and carries no real secret.
2. A `frontend/.env.test` filled in from the template, with the local passwords, lets E2E
   global setup finish the test-db reset and the rate-limit reset under
   `./deploy.sh test-up` with no Redis warning.

[BLOCKED by Architect] Waits on `architect-e2e-postgres-redis-loopback-ports`, which adds
the loopback port mappings to `docker-compose.test.override.yml`. Until those exist, the
127.0.0.1 addresses this template would name answer nothing. The architect moves this file
to `pending/` when that lands.

**Unblocked by Architect (2026-09-22).** The override now publishes postgres on
`127.0.0.1:5432` and redis on `127.0.0.1:6379` under `./deploy.sh test-up`, verified with
`docker port` and a global-setup run against both loopback URLs. The `test-up` banner in
`deploy.sh` prints the same two addresses; keep the template's wording consistent with it.

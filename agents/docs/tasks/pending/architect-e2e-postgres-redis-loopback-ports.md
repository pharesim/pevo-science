# Publish Postgres and Redis on loopback in the E2E override

**Owner:** architect
**Created:** 2026-09-22

Filed by the backend agent at the user's request.

## Why

E2E reaches Postgres and Redis through docker-network IPs hardcoded in the gitignored
`frontend/.env.test` (`APP_DATABASE_URL`, `REDIS_URL`). Those addresses do not stay put:

- Docker assigns them when containers join the network. After the Docker restart at
  2026-09-21 00:16 UTC, `pevo-ipfs-1` came back on 172.20.0.2, Redis's old address, and
  Redis on 172.20.0.5. The local `frontend/.env.test` points `REDIS_URL` at 172.20.0.4,
  which is now `pevo-backend-1`.
- `./deploy.sh test-up` can recreate the Postgres container, which has moved its IP
  mid-session before (172.20.0.3 to 172.20.0.7).

A stale `APP_DATABASE_URL` fails global setup's `test-db:reset`, so no spec runs. A stale
`REDIS_URL` makes global setup skip the rate-limit reset, so signup and recovery specs can
429, and makes global teardown skip its Redis cleanup. Both skips only warn. The current
workaround is to look the IPs up with `docker inspect` after `test-up` and pass them on the
command line for every run.

Neither service publishes a host port today. Nothing on the host listens on 5432 or 6379,
and the `combflow` stack on the same Docker host publishes neither.

## Scope

1. In `docker-compose.test.override.yml`, add `postgres` and `redis` entries at the same
   level as `backend` and `mailpit`, each carrying only a loopback port mapping, the way
   `mailpit` publishes 8025:

   ```yaml
     postgres:
       ports:
         - "127.0.0.1:5432:5432"

     redis:
       ports:
         - "127.0.0.1:6379:6379"
   ```

   Compose merges these into the `docker-compose.yml` definitions, which carry no `ports:`
   for either service, so the mapping is all they add.
2. Update the override's header comment. It says Postgres, Redis and IPFS stay shared with
   the dev stack; it should add that under `test-up` Postgres and Redis are also published
   on 127.0.0.1 for the E2E harness.
3. When this lands, move `ui-env-test-example-loopback-urls` from `blocked/` to `pending/`.

## Acceptance criteria

1. After `./deploy.sh test-up`, `docker port pevo-postgres-1` prints
   `5432/tcp -> 127.0.0.1:5432` and `docker port pevo-redis-1` prints
   `6379/tcp -> 127.0.0.1:6379`.
2. After `./deploy.sh up`, neither container publishes a port, so dev mode is unchanged.
3. With both URLs in `frontend/.env.test` on 127.0.0.1, E2E global setup completes the
   test-db reset and the rate-limit reset with no Redis warning.

## Notes

- Adding the mappings recreates both containers on the next `test-up`. Their data lives in
  the `pgdata` and `redis_data` named volumes.
- While in test mode, loopback exposes both `pevo_app` and `pevo_app_test`. The harness's
  `test-db:reset` hook and `queryAppDb` helper refuse any database whose name does not end
  in `_test`.
- The user's local `frontend/.env.test` needs its two URLs switched to 127.0.0.1 by hand;
  nothing in the repo writes that file.
- Open, not part of this scope: whether to publish the same ports in `docker-compose.yml`
  too, so host-side backend test runs (root `CLAUDE.md` "Running Tests", which also looks
  the IPs up with `docker inspect`) get a fixed address. Every backend vitest run loads
  `backend/tests/setup.ts`, which deletes all `${APP_TAG}:*` keys whenever Redis answers,
  so making dev Redis reachable from the host by default would let any test run wipe the
  dev backend's Redis state. The repo-root `.env` no longer carries a `REDIS_URL` (removed
  2026-09-22), so host-side runs reach Redis only when one is passed on the command line.

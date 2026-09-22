## UI-ENV-TEST-EXAMPLE-LOOPBACK-URLS — Point the .env.test template at the loopback ports (archived 2026-09-22) — completed by the user's direct edit in 4c8d9b45, all three scope items covered, no /ce-code-review run (user-authored, architect read the full diff) ✓

### Architect archive note (2026-09-22)

The template now names `127.0.0.1` for `APP_DATABASE_URL`, adds `REDIS_URL` with a placeholder password and a comment naming the two key families the harness touches (`${APP_TAG}:rl:*` in global-setup, `${APP_TAG}:ipfs:pending:<cid>` in global-teardown) and the warn-and-skip behavior when the value is wrong, and its header says both URLs answer only under `./deploy.sh test-up` and why the literal `127.0.0.1` matters. AC 1 holds (no real secret). AC 2 was verified by the architect on 2026-09-22 by running global-setup against both loopback URLs: test-db reset and rate-limit reset completed with no Redis warning.

### Point the .env.test template at the loopback ports

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

**Note (architect, 2026-09-22).** The user edited `frontend/.env.test.example` directly: the
`APP_DATABASE_URL` host is now `127.0.0.1` and a `REDIS_URL` line with a placeholder password
was added (scope item 2 done, item 1 partly). Once that edit is committed, what remains is
the `REDIS_URL` comment from scope item 1 and the header sentence from scope item 3. The
review of the loopback-ports commit also asked that the template keep the literal
`127.0.0.1`, never `localhost`: the bind is IPv4-only and `localhost` can resolve `::1`
first for `pg`.

## ARCHITECT-E2E-POSTGRES-REDIS-LOOPBACK-PORTS — Publish Postgres and Redis on loopback in the E2E override (archived 2026-09-22) — implemented by the architect in 6b50b6f3, /ce-code-review (7 reviewers) returned one P2 design call and one P3, both fixed in abfdcc00; base-file redis comment added at archive; ui-env-test-example-loopback-urls unblocked ✓

### Architect archive note (2026-09-22)

Review verdict: ready with fixes, all applied. #1 (P2, reliability + adversarial, validated): every dev/test mode switch and a restart issued in test mode now recreates postgres and redis; resolved with option (a), a `warn_infra_bounce` line before the recreating step in `up`, `test-up` and `restart` plus the override header. #2 (P3, correctness + adversarial, validated): the banner's angle-bracket REDIS_URL placeholder parsed as a redirection when pasted; the banner now prints both URLs as `$(grep ... .env)` substitutions through a quoted heredoc, so no secret reaches the terminal. Also fixed: the pre-existing "from frontend/" wording and a pre-flight that fails `test-up` when a foreign listener holds 5432 or 6379. Dismissed as residual: a base-config no-ports canary (the base file now carries the why on the redis service instead), restart-during-test-up, the WSL relay question, pg/ioredis reconnect behavior. The user's local `frontend/.env.test` needed `127.0.0.1` in place of `172.0.0.1`; the user updated `frontend/.env.test.example` directly (ui zone) while this archived.

### Publish Postgres and Redis on loopback in the E2E override

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

## Implementation (architect, 2026-09-22)

Landed in `6b50b6f3`. Scope items 1 and 2 as specified; item 3 done in `fb6569fe`
(`ui-env-test-example-loopback-urls` moved to `pending/`). Two additions beyond the listed
scope, both in architect-owned files: the `test-up` banner in `deploy.sh` prints the
loopback `APP_DATABASE_URL` instead of a `docker inspect` lookup and now also names
`REDIS_URL` (global-setup only warns when it is missing); the postgres comment in
`docker-compose.yml` points at the override so "no host port" stays accurate for dev.
The `test-db-up` banner is unchanged because that command also runs under plain `up`,
where loopback answers nothing.

Acceptance criteria, all verified on the dev host:

1. After `test-up`: `docker port pevo-postgres-1` prints `5432/tcp -> 127.0.0.1:5432`,
   `docker port pevo-redis-1` prints `6379/tcp -> 127.0.0.1:6379`; `ss -ltn` shows both
   bound to 127.0.0.1 only.
2. After `up`: `docker port` prints nothing for either container, no host listener on
   5432 or 6379, backend routed back at `pevo_app`.
3. `global-setup.js` invoked directly with both URLs on 127.0.0.1: test-db reset truncated
   7 tables, rate-limit reset cleared 1 key under `pevotest:rl:*`, no Redis warning.

Observed while verifying: the local `frontend/.env.test` names `172.0.0.1` for both hosts,
which is a routable address, not loopback; it needs `127.0.0.1`. Left for the user, since
nothing in the repo writes that file.

## BACKEND-ALTER-ACCOUNTS-IF-EXISTS-EVADES-PIN — The ALTER pin does not admit the IF EXISTS spelling (archived 2026-09-22) — 3 hold rounds (4+4+1 items, all FIXED), round 4 review clean; one advisory folded into the note below, round-4 [TODO Architect] items 1 and 2 and round-2 [TODO Architect] items 1, 5 and 6 dismissed at archive ✓

### Architect archive note (2026-09-22, round 4)

Reviewed at b93a3b04 (with the task move 7213d0ac) via /ce-code-review across
five lenses: correctness, project-standards, testing, adversarial in-process,
learnings. Dispatched 5, returned 5, no dead votes. No cross-model pass (pinned
range; no different-provider CLI on this host). Both commits are ancestors of
main.

The one held item landed exactly as prescribed: the test-file delta is the single
token `single-atom`, non-comment lines byte-identical to the parent, and the
scoped sentence is TRUE under the reading the round-3 rows define. Verified by
four independent re-derivations of the signal block's Item 1 table (all 13 rows
reproduce), a 1433-mutant lookaround-free single-edit sweep (zero red the fourth
spelling alone, zero red `ONLY (accounts)` alone), and the three unchanged
sentences checked file-wide against every assertion. `tests/eslint/` 9 files /
139 tests, exit 0. Anchor gate clean with firing controls.

One advisory, folded here rather than held (text-only, task-file, architect
zone): the round-4 [TODO Architect] item 1 argued that excluding lookaround and
new alternatives is what keeps the paren alternative's two whitespace runs
matched apart. That sufficiency argument is false: the capture-plus-backreference
form `(?:ONLY\b(\s*)\(\1?|ONLY\s+)?` brings in neither construct and reds the
fourth spelling alone, and its mandatory form `(?:ONLY\b(\s*)\(\1|ONLY\s+)?` reds
`ONLY (accounts)` alone while admitting exactly the symmetric spellings. The
committed comment sentence is unaffected: a backreference is two edits (a
capturing wrap plus a new atom) and the rows name neither. The pin is the
operations the rows name, not the excluded constructs.

Dispositions at archive:
- Round-4 [TODO Architect] item 1 (lookaround readings of "single-atom"):
  DISMISSED. The hold defined the term by its rows and the comment fixes it by
  two worked examples; every counterexample, lookaround or backreference,
  couples the two runs, which no delete/optional/mandatory/quantifier operation
  can do. Three lenses converged.
- Round-4 [TODO Architect] item 2 (the "styles" reading of round-3 item 2):
  DISMISSED. The prune it rationalises was dismissed in round 3.
- Round-2 [TODO Architect] item 1 (catalog-qualified `pevo_app.public.accounts`):
  DISMISSED. No house style spells a three-part name.
- Round-2 [TODO Architect] items 5 (backslash truncation in `enclosingQuote` /
  `statementAt`) and 6 (the three sibling heads' quadratic `\(?\s*` spelling):
  DISMISSED here. Both live in the reader owned by the writer-canary task, which
  archived on 2026-09-22 with its own residual lists; the reader was rewritten
  there since round 2 and item 5 was never re-verified against it.
- No /ce-compound: the lens-versus-probe learning this round re-confirms is
  already captured in the 2026-09-08 source-discipline entry.

# The ALTER pin does not admit the IF EXISTS spelling

**Owner:** backend
**Created:** 2026-09-09

Routed out of the round-3 architect review of the `accounts.updated_at` writer
canary. Pre-existing rather than introduced by that round, so it is filed here
instead of held there.

## Why

`ALTER_ACCOUNTS_RE` in
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`
admits `ONLY` and a `public.` qualifier but not `IF EXISTS`. A migration
spelling `ALTER TABLE IF EXISTS accounts RENAME COLUMN updated_at TO touched_at;`
is not seen by the column-alteration arm and the suite stays green; without the
clause the same statement reds.

What makes this more than a spelling gap is that the bypass is the repo's own
house style. Migrations here are written idempotent, so `IF EXISTS` is the form
an author reaches for by default, not an evasion. The arm exists to catch a
migration that renames, drops, or retypes the column the `/link` stuck-recovery
ordering is measured against, and it is blind to the spelling most likely to
carry that change.

Verified by mutation during the round-3 review: with the clause, 21/21 green;
without it, 1 failure. The `ALTER COLUMN ... TYPE ... USING NOW()` form passes
too.

## Scope

1. Admit the clause in `ALTER_ACCOUNTS_RE`, between `ALTER TABLE` and the

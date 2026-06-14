# Persist backend logs for two weeks (survive restarts/recreations)

**Owner:** architect
**Created:** 2026-06-14

A real production incident (a 2026-06-12 ORCID signup failure) could not be
diagnosed two days later because the beta backend logs were already gone. Logs need
to persist for **~14 days** and survive container restarts so single-user incidents
stay investigable.

## Root cause of the loss

- `docker-compose.yml` has **no `logging:` config** on any service, so every
  container uses Docker's default `json-file` driver with no rotation.
- `./deploy.sh restart` runs `$COMPOSE down` then `up` (`cmd_restart`), which
  **destroys and recreates** the containers. The `json-file` logs live inside the
  per-container layer, so they are discarded on every restart/recreate.

So the logs vanish on each `./deploy.sh restart`, independent of size.

## Why size-based json-file rotation is not enough

Docker's `json-file` `max-size`/`max-file` options rotate by **size, not time**, and
the files are still per-container, so:
- a `down`/recreate still discards them, and
- "two weeks" cannot be expressed (a traffic spike rotates faster; a quiet period
  keeps stale logs).

The retention mechanism therefore has to live **off the container**.

## Requirement

- Backend service logs (at minimum) retained ~14 days.
- Retention survives `./deploy.sh restart` (down/up) and image rebuilds.
- Ideally time-based (drop logs older than 14 days), not just size-capped.

## Options (architect picks; confirm the beta host's logging stack first)

1. **journald driver + host retention (recommended if the host runs systemd).**
   Set `logging: { driver: journald }` on the backend (and likely postgres) service;
   configure the host journal for persistence and a 2-week window
   (`Storage=persistent`, `MaxRetentionSec=2week`, plus a `SystemMaxUse` size cap).
   Logs survive container recreation, time-based retention is native, minimal moving
   parts. Pino's JSON stdout flows into the journal; query with `journalctl`.
2. **Log shipper / aggregator.** Vector / Fluent Bit / Promtail tailing container
   stdout into Loki (or rotated files) with a 14-day retention policy. Best
   queryability, most moving parts; new service(s) in the stack.
3. **Host-mounted log volume + logrotate.** Bind-mount a host dir, have pino also
   write JSON there, and run `logrotate` (`daily`, `rotate 14`, `compress`). Survives
   recreation but is cross-zone (pino transport in `backend/` + the volume mount in
   `docker-compose.yml`) and duplicates stdout.

## Acceptance criteria

- Backend logs from >24h ago are retrievable after a `./deploy.sh restart`.
- Logs older than ~14 days are pruned automatically.
- Whichever mechanism is chosen, document in `deploy.sh` / compose comments that
  in-container `json-file` logs do NOT survive `down`/recreate, so the retention must
  stay off the container.

## Zone note

This is deploy-infra: `docker-compose.yml` and/or `deploy.sh` (architect zone), plus
possibly host-level systemd/journald config outside the repo. Option 3 also touches
`backend/` (pino transport) and would need backend-agent coordination.

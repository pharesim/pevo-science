#!/usr/bin/env bash
set -euo pipefail

# PEvO deploy script
# Usage: ./deploy.sh [command]
#   build         — build Docker images
#   up            — start all services (detached)
#   down          — stop all services
#   migrate       — run database migrations against pevo_app
#   logs          — tail logs from all services
#   restart       — rebuild and restart all services
#   status        — show service status
#   clean         — stop services and remove volumes (DESTRUCTIVE)
#   test-db-up    — provision pevo_app_test and run migrations against it (idempotent)
#   test-db-down  — drop pevo_app_test (DESTRUCTIVE)
#   test-up       — start services with backend routed at pevo_app_test (for E2E)

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[pevo]${NC} $*"; }
warn() { echo -e "${YELLOW}[pevo]${NC} $*"; }
err()  { echo -e "${RED}[pevo]${NC} $*" >&2; }

check_deps() {
  if ! command -v docker &>/dev/null; then
    err "Required command not found: docker"
    exit 1
  fi

  if docker compose version &>/dev/null; then
    COMPOSE="docker compose"
  elif command -v docker-compose &>/dev/null; then
    COMPOSE="docker-compose"
  else
    err "Neither 'docker compose' plugin nor 'docker-compose' found."
    err "Install one: https://docs.docker.com/compose/install/"
    exit 1
  fi
}

check_env() {
  if [ ! -f .env ]; then
    warn ".env not found — copying from .env.example"
    cp .env.example .env
    warn "Edit .env with your actual credentials before production use"
  fi
}

cmd_build() {
  log "Building Docker images..."
  DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 $COMPOSE build "$@"
  log "Build complete"
}

cmd_up() {
  check_env
  log "Starting services..."
  # --remove-orphans cleans up services introduced by docker-compose.test.override.yml
  # (e.g. mailpit) when switching back from `test-up` to plain `up`.
  $COMPOSE up -d --remove-orphans "$@"
  log "Waiting for backend to be healthy..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if $COMPOSE exec -T backend wget -qO- http://localhost:3001/api/health &>/dev/null; then
      log "Backend is healthy"
      break
    fi
    retries=$((retries - 1))
    sleep 2
  done
  if [ $retries -eq 0 ]; then
    warn "Backend did not become healthy within 60s — check logs with: ./deploy.sh logs backend"
  fi
  cmd_status
}

cmd_down() {
  log "Stopping services..."
  $COMPOSE down "$@"
  log "Services stopped"
}

# Run all backend migration SQL files against the named database.
# Single call site used by both cmd_migrate (pevo_app) and cmd_test_db_up (pevo_app_test).
# The postgres container mounts backend/migrations at /docker-entrypoint-initdb.d/ (ro),
# so no host-side psql is required.
migrate_db() {
  local db="$1"
  if [ -z "$db" ]; then
    err "migrate_db: database name required"
    return 1
  fi
  log "Running database migrations against '$db'..."
  for f in backend/migrations/*.sql; do
    log "  Applying $(basename "$f") to $db..."
    $COMPOSE exec -T postgres psql -U pevo -d "$db" -v ON_ERROR_STOP=1 -f "/docker-entrypoint-initdb.d/$(basename "$f")"
  done
  log "Migrations complete for $db"
}

cmd_migrate() {
  migrate_db "pevo_app"
}

cmd_test_db_up() {
  log "Provisioning test database 'pevo_app_test'..."
  # CREATE DATABASE is not transactional and has no IF NOT EXISTS; swallow the
  # duplicate-database error and continue so this command stays idempotent.
  if $COMPOSE exec -T postgres psql -U pevo -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = 'pevo_app_test'" | grep -q 1; then
    log "pevo_app_test already exists — skipping create"
  else
    $COMPOSE exec -T postgres psql -U pevo -d postgres -v ON_ERROR_STOP=1 \
      -c "CREATE DATABASE pevo_app_test OWNER pevo"
    log "pevo_app_test created"
  fi

  migrate_db "pevo_app_test"

  local pg_ip
  pg_ip=$(docker inspect pevo-postgres-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || echo "")
  local pw
  pw=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2)

  log ""
  log "Test database is ready."
  log "Host-side connection URL for Playwright global-setup and the reset script:"
  if [ -n "$pg_ip" ] && [ -n "$pw" ]; then
    echo "  APP_DATABASE_URL=postgresql://pevo:${pw}@${pg_ip}:5432/pevo_app_test"
    log ""
    log "Reset tables between runs:"
    echo "  APP_DATABASE_URL=postgresql://pevo:${pw}@${pg_ip}:5432/pevo_app_test \\"
    echo "    npm run --prefix backend test-db:reset"
  else
    warn "Could not resolve postgres IP or password — check 'docker ps' and .env"
  fi
}

cmd_test_up() {
  check_env
  if [ ! -f docker-compose.test.override.yml ]; then
    err "docker-compose.test.override.yml not found"
    exit 1
  fi
  # Verify pevo_app_test exists before recreating the backend to point at it;
  # compose will happily bring the backend up against a missing DB and the app
  # will crash on its first query — easier to fail fast here.
  if ! $COMPOSE exec -T postgres psql -U pevo -d postgres -tAc \
       "SELECT 1 FROM pg_database WHERE datname = 'pevo_app_test'" 2>/dev/null | grep -q 1; then
    err "pevo_app_test does not exist. Run: ./deploy.sh test-db-up"
    exit 1
  fi
  log "Starting services with backend routed at pevo_app_test..."
  $COMPOSE -f docker-compose.yml -f docker-compose.test.override.yml up -d "$@"
  log "Waiting for backend to be healthy..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if $COMPOSE exec -T backend wget -qO- http://localhost:3001/api/health &>/dev/null; then
      log "Backend is healthy (routed at pevo_app_test)"
      break
    fi
    retries=$((retries - 1))
    sleep 2
  done
  if [ $retries -eq 0 ]; then
    warn "Backend did not become healthy within 60s — check logs with: ./deploy.sh logs backend"
  fi
  log ""
  log "E2E stack is ready. Run Playwright from frontend/:"
  local pg_ip pw
  pg_ip=$(docker inspect pevo-postgres-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || echo "")
  pw=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2)
  if [ -n "$pg_ip" ] && [ -n "$pw" ]; then
    echo "  APP_DATABASE_URL=postgresql://pevo:${pw}@${pg_ip}:5432/pevo_app_test \\"
    echo "    PEVO_TEST_BASE_URL=http://localhost:3001 \\"
    echo "    npm --prefix frontend run test:e2e"
  fi
  log ""
  log "Restore dev routing when done: ./deploy.sh up"
}

cmd_test_db_down() {
  warn "This will DROP database 'pevo_app_test' and all data in it."
  read -rp "Are you sure? (y/N) " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    $COMPOSE exec -T postgres psql -U pevo -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS pevo_app_test"
    log "pevo_app_test dropped"
  else
    log "Aborted"
  fi
}

cmd_logs() {
  $COMPOSE logs -f "$@"
}

cmd_restart() {
  log "Rebuilding and restarting..."
  $COMPOSE down
  DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 $COMPOSE build
  cmd_up
  log "Applying migrations..."
  cmd_migrate
}

cmd_status() {
  log "Service status:"
  $COMPOSE ps
}

cmd_clean() {
  warn "This will stop all services and DELETE all data volumes."
  read -rp "Are you sure? (y/N) " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    $COMPOSE down -v
    log "Services stopped, volumes removed"
  else
    log "Aborted"
  fi
}

cmd_help() {
  echo "Usage: $0 <command> [args...]"
  echo ""
  echo "Commands:"
  echo "  build         Build Docker images"
  echo "  up            Start all services (detached)"
  echo "  down          Stop all services"
  echo "  migrate       Run database migrations against pevo_app"
  echo "  logs          Tail logs (optionally: ./deploy.sh logs backend)"
  echo "  restart       Rebuild and restart all services"
  echo "  status        Show service status"
  echo "  clean         Stop services and remove volumes (DESTRUCTIVE)"
  echo "  test-db-up    Provision pevo_app_test and migrate (idempotent)"
  echo "  test-db-down  Drop pevo_app_test (DESTRUCTIVE)"
  echo "  test-up       Start services with backend routed at pevo_app_test (for E2E)"
  echo "  help          Show this help"
}

# --- Main ---
check_deps

case "${1:-help}" in
  build)        shift; cmd_build "$@" ;;
  up)           shift; cmd_up "$@" ;;
  down)         shift; cmd_down "$@" ;;
  migrate)      shift; cmd_migrate "$@" ;;
  logs)         shift; cmd_logs "$@" ;;
  restart)      shift; cmd_restart "$@" ;;
  status)       shift; cmd_status "$@" ;;
  clean)        shift; cmd_clean "$@" ;;
  test-db-up)   shift; cmd_test_db_up "$@" ;;
  test-db-down) shift; cmd_test_db_down "$@" ;;
  test-up)      shift; cmd_test_up "$@" ;;
  help|*)       cmd_help ;;
esac

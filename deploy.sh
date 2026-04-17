#!/usr/bin/env bash
set -euo pipefail

# PEvO deploy script
# Usage: ./deploy.sh [command]
#   build    — build Docker images
#   up       — start all services (detached)
#   down     — stop all services
#   migrate  — run database migrations
#   logs     — tail logs from all services
#   restart  — rebuild and restart all services
#   status   — show service status
#   clean    — stop services and remove volumes (DESTRUCTIVE)

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
  $COMPOSE up -d "$@"
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

cmd_migrate() {
  log "Running database migrations..."
  for f in backend/migrations/*.sql; do
    log "  Applying $(basename "$f")..."
    $COMPOSE exec -T postgres psql -U pevo -d pevo_app -f "/docker-entrypoint-initdb.d/$(basename "$f")"
  done
  log "Migrations complete"
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
  echo "  build    Build Docker images"
  echo "  up       Start all services (detached)"
  echo "  down     Stop all services"
  echo "  migrate  Run database migrations"
  echo "  logs     Tail logs (optionally: ./deploy.sh logs backend)"
  echo "  restart  Rebuild and restart all services"
  echo "  status   Show service status"
  echo "  clean    Stop services and remove volumes (DESTRUCTIVE)"
  echo "  help     Show this help"
}

# --- Main ---
check_deps

case "${1:-help}" in
  build)   shift; cmd_build "$@" ;;
  up)      shift; cmd_up "$@" ;;
  down)    shift; cmd_down "$@" ;;
  migrate) shift; cmd_migrate "$@" ;;
  logs)    shift; cmd_logs "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  status)  shift; cmd_status "$@" ;;
  clean)   shift; cmd_clean "$@" ;;
  help|*)  cmd_help ;;
esac

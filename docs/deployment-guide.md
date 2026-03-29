# PEvO Deployment Guide

> **Owner:** Architect Agent
> **Version:** 0.1

## Prerequisites

### Hive Accounts

Two Hive accounts must be created before deployment:

| Account | Purpose | Key Requirements |
|---------|---------|-----------------|
| `pevo.admin` | Broadcasts accreditation `custom_json` | Posting key stored in backend env |
| `pevo.anon` | Posts anonymous reviews | Posting key stored in backend env |

Create these accounts via any Hive account creation service. Fund with enough RC (Resource Credits) for expected transaction volume. Delegate HP if needed.

### External Services

| Service | Required | Purpose |
|---------|----------|---------|
| HAF SQL node | Yes (primary data) | PostgreSQL with indexed Hive chain data |
| SMTP server | Yes (accreditation) | Sends verification emails |
| Pinata API key | Yes (IPFS) | Pins uploaded PDFs |
| Redis | Optional (recommended for production) | Rate limiting, caching |

---

## Environment Variables

All configuration lives in a single `.env` file at the project root (see `.env.example` for the full list). Key production values:

```bash
# Public URLs
APP_URL=https://pevo.science
NEXT_PUBLIC_API_URL=https://pevo.science

# Database
POSTGRES_PASSWORD=<strong-random>

# Hive account keys
PEVO_ADMIN_POSTING_KEY=5K...
PEVO_ANON_POSTING_KEY=5K...

# Anonymous review encryption (openssl rand -hex 32)
ANON_REVIEW_ENCRYPTION_KEY=...
```

See [.env.example](../.env.example) for all available variables.

---

## Database Setup

### HAF SQL

The backend queries the HAF node using inline CTEs against the raw `hafsql.*` tables (comments, operation_custom_json_view, etc.). **No `pevo` schema or CREATE privilege is required** on the HAF node. The `docs/haf-views.sql` file is a design reference only.

Set `HAF_DATABASE_URL` in `.env` to point to the HAF node (read-only access is sufficient).

### Application Database

Docker Compose automatically creates the `pevo_app` database. Migrations in `backend/migrations/` run on first start via the `/docker-entrypoint-initdb.d` mount. This stores notification preferences, accreditation tokens, and anonymous review mappings.

---

## Docker Deployment

### Development

```bash
cp .env.example .env
./deploy.sh up          # uses docker-compose.yml — ports 3000/3001 exposed
```

### Production

```bash
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD, NEXT_PUBLIC_API_URL, APP_URL, real keys
./deploy.sh up
```

The same `docker-compose.yml` is used for both dev and production. The stack includes:
- **postgres** — PostgreSQL for app state (1GB memory limit)
- **redis** — Caching, rate limiting, ORCID state (256MB limit)
- **backend** — Node.js API server (512MB limit, health-checked)
- **frontend** — Next.js app (256MB limit)

The reverse proxy (TLS termination, routing) is managed outside of Docker Compose. Configure your existing reverse proxy to route `/api/` to `localhost:3001` (pass the `/api/` prefix through, do not strip it) and `/` to `localhost:3000`.

Set `NEXT_PUBLIC_API_URL` to your public base URL (e.g., `https://pevo.science`) — **not** with an `/api` suffix, as the frontend code already adds `/api/` to all routes. Set `APP_URL` to the same value.

### 4. Set up backups

```bash
# Install the daily backup cron job
sudo cp scripts/backup.sh /usr/local/bin/pevo-backup
sudo chmod +x /usr/local/bin/pevo-backup

# Add cron entry (daily at 03:00)
echo "0 3 * * * root APP_DATABASE_URL=postgresql://pevo:PASS@localhost:5432/pevo_app /usr/local/bin/pevo-backup >> /var/log/pevo-backup.log 2>&1" | sudo tee /etc/cron.d/pevo-backup

# Or run from inside Docker Compose:
docker compose exec postgres pg_dump -U pevo pevo_app | gzip > backup.sql.gz
```

### Health Check

```bash
curl https://pevo.science/api/health
# Expected: {"status":"ok","haf_available":true,"redis_available":true,"timestamp":"..."}
```

---

## Development

```bash
cp .env.example .env
docker compose up -d
# Frontend: http://localhost:3000, API: http://localhost:3001
```

---

## Manual Deployment

### Backend

```bash
cd backend
npm ci
npm run build
NODE_ENV=production node dist/index.js
```

Runs on `PORT` (default 3001). Place behind a reverse proxy for TLS.

### Frontend

```bash
cd frontend
npm ci
npm run build
npm start
```

Runs on port 3000. The `NEXT_PUBLIC_API_URL` must point to the backend.

---

## Backup and Restore

### Automated Backups

The `scripts/backup.sh` script dumps the `pevo_app` database daily and retains the last 7 backups.

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_DIR` | `/var/backups/pevo` | Where dumps are stored |
| `BACKUP_KEEP_DAYS` | `7` | Days to retain |
| `APP_DATABASE_URL` | (required) | PostgreSQL connection string |

### Restore

```bash
gunzip -c /var/backups/pevo/pevo_app_20260326_030000.sql.gz | psql $APP_DATABASE_URL
```

---

## Monitoring

### Key Metrics

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| HAF availability | `GET /api/health` | `haf_available: false` |
| API response time | Backend logs (pino) | p95 > 2s |
| Error rate | Backend logs (5xx) | > 1% of requests |
| IPFS pin failures | Backend logs | Any failure |
| Accreditation broadcast failures | Backend logs | Any failure |
| Rate limit hits | Backend logs (429s) | Spike detection |

### Log Format

Backend uses structured JSON logging (pino). Pipe to your log aggregation service.

---

## Security Checklist

- [ ] All private keys (`PEVO_ADMIN_POSTING_KEY`, `PEVO_ANON_POSTING_KEY`, `ANON_REVIEW_ENCRYPTION_KEY`) stored in environment variables, never in code or version control
- [ ] `.env` files excluded from git (`.gitignore`)
- [ ] CORS restricted to `APP_URL` in production
- [ ] TLS termination at reverse proxy
- [ ] Rate limiting enabled on all public endpoints
- [ ] SMTP credentials use app-specific password
- [ ] Redis authentication enabled if exposed
- [ ] HAF database user has read-only access to `hafsql.*` schema
- [ ] File upload validation (PDF only, 10MB max) enforced server-side
- [ ] Anonymous review encryption key is unique, random 32 bytes

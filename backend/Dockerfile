# ── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Build frontend (Vite outputs to ../backend/public/)
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm ci
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# Install backend dependencies
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install --ignore-scripts

# Build backend
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
COPY backend/scripts ./backend/scripts
RUN cd backend && npx tsc

# Generate academic domain database from JetBrains/swot
RUN apk add --no-cache git bash \
    && cd backend && bash scripts/update-academic-domains.sh \
    && apk del git bash

# ── Production stage ─────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install backend production dependencies
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install --omit=dev --ignore-scripts

# Copy built backend + academic domain data
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/data ./backend/data

# Copy compiled frontend (Vite build output)
COPY --from=build /app/backend/public ./backend/public

WORKDIR /app/backend

# Run as non-root user for security
RUN addgroup -g 1001 -S pevo && adduser -S pevo -G pevo -u 1001
USER pevo

ENV NODE_ENV=production
ENV PORT=3001
# Cap libuv thread pool above argon2's effective serialization so the
# burnSentinel path in src/routes/auth.ts cannot silently throw under
# concurrent /login, /signup, /resend-verification, /recover load. This
# ENV applies to all container consumers (k8s, direct image run, ECS)
# regardless of whether docker-compose.yml is involved. The JS-level
# semaphore in auth.ts (see SENTINEL_ARGON2_HASH_PROMISE comment) is the
# real deterministic cap; this value is libuv headroom to ensure the
# semaphore can fill its 4 concurrent slots without blocking on the pool.
ENV UV_THREADPOOL_SIZE=16

EXPOSE 3001

CMD ["node", "dist/index.js"]

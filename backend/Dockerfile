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
RUN cd backend && npx tsc

# ── Production stage ─────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install backend production dependencies
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install --omit=dev --ignore-scripts

# Copy built backend
COPY --from=build /app/backend/dist ./backend/dist

# Copy compiled frontend (Vite build output)
COPY --from=build /app/backend/public ./backend/public

WORKDIR /app/backend

# Run as non-root user for security
RUN addgroup -g 1001 -S pevo && adduser -S pevo -G pevo -u 1001
USER pevo

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/index.js"]

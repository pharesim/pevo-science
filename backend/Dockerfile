# ── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Build contracts package (local dependency)
COPY contracts/package.json contracts/tsconfig.json ./contracts/
COPY contracts/src ./contracts/src
RUN cd contracts && npm install && npm run build

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

# Copy built contracts (with dist and package.json only)
COPY --from=build /app/contracts/package.json ./contracts/
COPY --from=build /app/contracts/dist ./contracts/dist

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

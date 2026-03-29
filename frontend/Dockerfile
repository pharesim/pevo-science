# ── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Build contracts package (local dependency)
COPY contracts/package.json contracts/tsconfig.json ./contracts/
COPY contracts/src ./contracts/src
RUN cd contracts && npm install && npm run build

# Install frontend dependencies
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm install

# Build frontend
COPY frontend/next.config.mjs frontend/tsconfig.json frontend/postcss.config.mjs frontend/tailwind.config.ts ./frontend/
COPY frontend/src ./frontend/src
COPY frontend/public ./frontend/public
COPY frontend/messages ./frontend/messages
ENV NEXT_TELEMETRY_DISABLED=1

# Next.js inlines NEXT_PUBLIC_* at build time.
# APP_TAG/APP_VERSION are mapped to NEXT_PUBLIC_* by next.config.mjs,
# so we only need the unprefixed names here.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ARG APP_TAG=pevo
ARG APP_VERSION=0.1
ARG NEXT_PUBLIC_CONTACT_EMAIL=support@pevo.science
ARG NEXT_PUBLIC_DISCORD_URL=
ARG NEXT_PUBLIC_GITHUB_ISSUES_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV APP_TAG=$APP_TAG
ENV APP_VERSION=$APP_VERSION
ENV NEXT_PUBLIC_CONTACT_EMAIL=$NEXT_PUBLIC_CONTACT_EMAIL
ENV NEXT_PUBLIC_DISCORD_URL=$NEXT_PUBLIC_DISCORD_URL
ENV NEXT_PUBLIC_GITHUB_ISSUES_URL=$NEXT_PUBLIC_GITHUB_ISSUES_URL

RUN cd frontend && npm run build

# ── Production stage ─────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Standalone output includes its own node_modules — no install needed
COPY --from=build /app/frontend/.next/standalone ./
COPY --from=build /app/frontend/.next/static ./.next/static
COPY --from=build /app/frontend/public ./public
COPY --from=build /app/frontend/messages ./frontend/messages

# Run as non-root user for security
RUN addgroup -g 1001 -S pevo && adduser -S pevo -G pevo -u 1001
USER pevo

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

CMD ["node", "server.js"]

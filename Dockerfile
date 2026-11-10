# ==============================================================================
# Mermaid - Unified AI Revenue Cycle Operating System
# Production Multi-Stage Dockerfile (Node 22 / Hardened / Multi-Role)
# ==============================================================================

# Stage 1: Build & Dependencies
FROM node:22-bookworm-slim AS builder

WORKDIR /app

ENV NODE_ENV=production

# Copy workspace package manifests first for efficient layer caching
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY platform/auth/package.json ./platform/auth/
COPY platform/config/package.json ./platform/config/
COPY platform/crypto/package.json ./platform/crypto/
COPY platform/db/package.json ./platform/db/
COPY platform/edi/package.json ./platform/edi/
COPY platform/events/package.json ./platform/events/
COPY platform/llm/package.json ./platform/llm/
COPY platform/observability/package.json ./platform/observability/
COPY platform/payer-profile/package.json ./platform/payer-profile/
COPY platform/webhook/package.json ./platform/webhook/
COPY modules/analytics/package.json ./modules/analytics/
COPY modules/claims/package.json ./modules/claims/
COPY modules/denials-appeals/package.json ./modules/denials-appeals/
COPY modules/patient-ledger/package.json ./modules/patient-ledger/
COPY modules/remittance/package.json ./modules/remittance/
COPY modules/verification/package.json ./modules/verification/
COPY apps/web/package.json ./apps/web/

# Install dependencies (workspaces symlinks created deterministically)
RUN npm ci --omit=dev

# Stage 2: Production Runtime
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Run as unprivileged node user
USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV PROCESS_ROLE=all

# Copy node_modules and package definitions from builder
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node package.json ./

# Copy runtime application code
COPY --chown=node:node packages ./packages
COPY --chown=node:node platform ./platform
COPY --chown=node:node modules ./modules
COPY --chown=node:node apps ./apps
COPY --chown=node:node scripts ./scripts

USER root
RUN chmod +x /app/scripts/docker-entrypoint.sh
USER node

EXPOSE 3000

# Use role entrypoint dispatcher (supports 'web', 'worker', 'jobs', or 'all')
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["all"]

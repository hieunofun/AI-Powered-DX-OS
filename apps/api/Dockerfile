# ==============================================================================
# SmartProcure-Pay Backend API - Multi-Stage Dockerfile
# ==============================================================================

# Stage 1: Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Copy monorepo manifests
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/ ./packages/

# Install build dependencies
RUN npm install

# Copy API source and compile TypeScript bundle
COPY apps/api/ ./apps/api/
RUN npm run build:api

# Stage 2: Production runner stage
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

# Copy manifests and install production-only dependencies
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
RUN npm install --omit=dev

# Copy compiled artifacts from builder
COPY --from=builder /app/apps/api/dist ./apps/api/dist

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

CMD ["node", "apps/api/dist/main.js"]

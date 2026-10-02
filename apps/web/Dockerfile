# ==============================================================================
# SmartProcure-Pay Web Frontend - Multi-Stage Dockerfile
# ==============================================================================

# Stage 1: Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Copy monorepo manifests
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/ ./packages/

# Install build dependencies
RUN npm install

# Copy web source and compile production bundle
COPY apps/web/ ./apps/web/
RUN npm run build:web

# Stage 2: Production Nginx serving stage
FROM nginx:alpine AS runner
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80 || exit 1

CMD ["nginx", "-g", "daemon off;"]

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

# Build-time argument for API Base URL and Keycloak
ARG VITE_API_BASE_URL=http://localhost:4000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ARG VITE_KEYCLOAK_URL=http://localhost:8080
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL
ARG VITE_KEYCLOAK_REALM=smartprocure
ENV VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM
ARG VITE_KEYCLOAK_CLIENT_ID=smartprocure-web
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID

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

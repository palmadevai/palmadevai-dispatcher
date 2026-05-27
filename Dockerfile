# syntax=docker/dockerfile:1.7
# =============================================================================
# palmadevai-dispatcher — multi-stage build
# =============================================================================
# Mismo patrón canónico que palmadevai-{cockpit,chat-site,web}: build LOCAL
# en el VPS via GH Actions SSH, tag `dispatcher:latest`. Sin GHCR.
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --ignore-scripts: evita postinstall hooks de deps no auditadas.
# --omit=dev: solo runtime deps en este stage.
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# wget para HEALTHCHECK (alpine no trae curl).
RUN apk add --no-cache wget

# Runtime deps (sin dev) + dist compilado.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# uid 1000 alineado con n8n/chat-site/cockpit (no-root).
USER 1000:1000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]

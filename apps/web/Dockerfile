# Статика фронтенда, которую отдаёт Caddy. Он же терминирует TLS и проксирует
# /api в контейнер приложения.

FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/wb-core/package.json packages/wb-core/
COPY packages/ym-core/package.json packages/ym-core/
COPY apps/server/package.json apps/server/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY apps/web apps/web
RUN npm run build -w @watcher/web

FROM caddy:2-alpine
COPY --from=builder /app/apps/web/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

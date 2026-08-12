# Образ бэкенда: HTTP API + планировщик.
#
# curl в рантайме обязателен: wb-core ходит в Wildberries через него, потому что
# card.wb.ru отбивает запросы Node по TLS-фингерпринту. Без curl приложение
# соберётся, но не получит ни одной цены.

FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/wb-core/package.json packages/wb-core/
COPY apps/server/package.json apps/server/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/wb-core packages/wb-core
COPY apps/server apps/server
COPY apps/mcp apps/mcp
RUN npm run build -w @watcher/wb-core \
 && npm run build -w @watcher/server \
 && npm run build -w @watcher/mcp

FROM node:22-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/wb-core/package.json packages/wb-core/
COPY apps/server/package.json apps/server/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/packages/wb-core/dist packages/wb-core/dist
COPY --from=builder /app/apps/server/dist apps/server/dist
COPY --from=builder /app/apps/mcp/dist apps/mcp/dist
# SQL-миграции лежат рядом с кодом: migrate.js ищет их по ../../drizzle
COPY apps/server/drizzle apps/server/drizzle
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]

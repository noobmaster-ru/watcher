# Агент Озона: Chromium + Playwright на официальной базе Playwright — в ней уже
# есть браузер и его системные библиотеки.
#
# Сборка двухэтапная, как у основного образа: TypeScript и типы Node живут в
# dev-зависимостях корня монорепо, поэтому этап компиляции ставит зависимости
# целиком, а в рантайм уезжают только боевые пакеты и готовый dist.

FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/wb-core/package.json packages/wb-core/
COPY packages/ym-core/package.json packages/ym-core/
COPY packages/ozon-core/package.json packages/ozon-core/
COPY apps/server/package.json apps/server/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
COPY apps/ozon-agent/package.json apps/ozon-agent/
# полный ci: нужен typescript и @types/node из dev-зависимостей корня
RUN npm ci

COPY tsconfig.base.json ./
COPY apps/ozon-agent apps/ozon-agent
RUN npx tsc -b apps/ozon-agent

FROM mcr.microsoft.com/playwright:v1.49.0-jammy
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/wb-core/package.json packages/wb-core/
COPY packages/ym-core/package.json packages/ym-core/
COPY packages/ozon-core/package.json packages/ozon-core/
COPY apps/server/package.json apps/server/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
COPY apps/ozon-agent/package.json apps/ozon-agent/
RUN npm ci --omit=dev --workspace @watcher/ozon-agent && npm cache clean --force

COPY --from=builder /app/apps/ozon-agent/dist apps/ozon-agent/dist

EXPOSE 8100
CMD ["node", "apps/ozon-agent/dist/index.js"]

# Агент Озона: Chromium + Playwright. Отдельный образ на официальной базе
# Playwright — в ней уже есть браузер и все его системные библиотеки; собирать
# это руками в node:slim дольше и хрупче.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/wb-core/package.json packages/wb-core/
COPY packages/ym-core/package.json packages/ym-core/
COPY apps/server/package.json apps/server/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
COPY apps/ozon-agent/package.json apps/ozon-agent/
RUN npm ci --omit=dev --workspace @watcher/ozon-agent

COPY tsconfig.base.json ./
COPY apps/ozon-agent apps/ozon-agent
RUN npx tsc -b apps/ozon-agent

EXPOSE 8100
CMD ["node", "apps/ozon-agent/dist/index.js"]

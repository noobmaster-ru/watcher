#!/bin/sh
# Миграции применяются на каждом старте: drizzle пропускает уже накатанные,
# поэтому шаг идемпотентен и не требует отдельной ручной команды при деплое.
set -e

echo "[entrypoint] применяю миграции"
node apps/server/dist/db/migrate.js

echo "[entrypoint] запускаю сервер"
exec node apps/server/dist/index.js

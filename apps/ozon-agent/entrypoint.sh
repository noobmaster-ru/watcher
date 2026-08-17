#!/bin/sh
# Виртуальный экран для Chrome с окном плюс доступ к нему глазами.
#
# Xvfb рисует окно в память — Chrome работает как обычный, не headless, и
# антибот видит настоящий браузер. x11vnc отдаёт этот экран по VNC, а noVNC
# заворачивает VNC в обычную веб-страницу: человек открывает её в браузере,
# видит окно Chrome агента и проходит капчу руками. Наружу порт не торчит —
# приложение проксирует его только авторизованным пользователям.
set -e

export DISPLAY=:99
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp -ac > /dev/null 2>&1 &

# Chrome при некорректном завершении (убит по памяти, перезапуск контейнера)
# оставляет в профиле lock-файлы и потом отказывается стартовать «поверх
# работающего» экземпляра — которого давно нет. В контейнере Chrome всегда
# один, так что снимать замок при старте безопасно.
PROFILE="${OZON_PROFILE_DIR:-/data/ozon-profile}"
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie" 2>/dev/null || true

# ждём, пока X поднимется, иначе Chrome упадёт на старте
for i in $(seq 1 30); do
  if xdpyinfo -display :99 > /dev/null 2>&1; then break; fi
  sleep 0.5
done

x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 -localhost > /dev/null 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 > /dev/null 2>&1 &

echo "[entrypoint] Xvfb :99, VNC :5900, noVNC :6080"
exec node apps/ozon-agent/dist/index.js

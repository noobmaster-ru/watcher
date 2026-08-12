// Telegram-бот: привязка чата и доставка уведомлений.
//
// В отличие от Wildberries, Telegram не привередлив к клиенту — здесь обычный
// fetch без curl и без лимитеров сложнее «не больше 30 сообщений в секунду».

import { and, asc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db/client.js";
import { alerts, products, userChannels, watches } from "../db/schema.js";
import { config } from "../config.js";

const API = "https://api.telegram.org";
const BIND_TOKEN_TTL_MS = 15 * 60 * 1000;

export function isTelegramEnabled(): boolean {
  return Boolean(config.telegram.botToken);
}

async function callApi<T>(method: string, payload: unknown): Promise<T | null> {
  if (!config.telegram.botToken) return null;
  const response = await fetch(`${API}/bot${config.telegram.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(`Telegram ${method}: ${body.description ?? response.status}`);
  return body.result ?? null;
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  await callApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

/** Имя бота нужно для ссылки привязки; кешируем на процесс. */
let cachedBotUsername: string | null = null;
export async function getBotUsername(): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  if (!isTelegramEnabled()) return null;
  const me = await callApi<{ username?: string }>("getMe", {});
  cachedBotUsername = me?.username ?? null;
  return cachedBotUsername;
}

// ── привязка чата ────────────────────────────────────────────────────────────
/** Выдаёт одноразовую ссылку t.me/<bot>?start=<token>. */
export async function createBindLink(userId: number): Promise<{ url: string | null; token: string }> {
  const token = randomBytes(12).toString("base64url");
  const expiresAt = new Date(Date.now() + BIND_TOKEN_TTL_MS);
  await db
    .insert(userChannels)
    .values({ userId, bindToken: token, bindTokenExpiresAt: expiresAt })
    .onConflictDoUpdate({
      target: userChannels.userId,
      set: { bindToken: token, bindTokenExpiresAt: expiresAt },
    });

  const username = await getBotUsername();
  return { url: username ? `https://t.me/${username}?start=${token}` : null, token };
}

export async function unbindTelegram(userId: number): Promise<void> {
  await db
    .update(userChannels)
    .set({ telegramChatId: null, verifiedAt: null, bindToken: null, bindTokenExpiresAt: null })
    .where(eq(userChannels.userId, userId));
}

interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id?: number }; text?: string };
}

/** Обрабатывает /start <token> — единственную команду, которую понимает бот. */
export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim();
  if (!chatId || !text) return;

  if (!text.startsWith("/start")) {
    await sendMessage(String(chatId), "Чтобы получать уведомления, откройте ссылку привязки в настройках watcher.");
    return;
  }

  const token = text.slice("/start".length).trim();
  if (!token) {
    await sendMessage(String(chatId), "Откройте ссылку привязки из настроек watcher — она содержит одноразовый код.");
    return;
  }

  const [channel] = await db.select().from(userChannels).where(eq(userChannels.bindToken, token)).limit(1);
  if (!channel || !channel.bindTokenExpiresAt || channel.bindTokenExpiresAt.getTime() < Date.now()) {
    await sendMessage(String(chatId), "Ссылка привязки устарела. Сгенерируйте новую в настройках watcher.");
    return;
  }

  await db
    .update(userChannels)
    .set({
      telegramChatId: String(chatId),
      verifiedAt: new Date(),
      bindToken: null,
      bindTokenExpiresAt: null,
    })
    .where(eq(userChannels.userId, channel.userId));

  await sendMessage(String(chatId), "✅ Уведомления подключены. Пришлю сообщение, когда цена изменится.");
}

// ── доставка уведомлений ─────────────────────────────────────────────────────
const TITLES: Record<string, string> = {
  price_drop: "📉 Цена снизилась",
  price_rise: "📈 Цена выросла",
  out_of_stock: "⚠️ Товара нет в наличии",
  back_in_stock: "✅ Товар снова в продаже",
  new_product: "🆕 Новый товар у продавца",
};

const money = (value: number | null): string =>
  value === null ? "—" : `${value.toLocaleString("ru-RU")} ₽`;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatAlert(alert: {
  type: string;
  oldPrice: number | null;
  newPrice: number | null;
  nm: number;
  name: string | null;
  supplierName: string | null;
}): string {
  const lines = [`<b>${TITLES[alert.type] ?? "Событие"}</b>`];
  lines.push(escapeHtml(alert.name ?? `Артикул ${alert.nm}`));
  if (alert.supplierName) lines.push(`Продавец: ${escapeHtml(alert.supplierName)}`);

  if (alert.type === "price_drop" || alert.type === "price_rise") {
    const delta =
      alert.oldPrice !== null && alert.newPrice !== null ? alert.newPrice - alert.oldPrice : null;
    const pct =
      delta !== null && alert.oldPrice ? Math.round((delta / alert.oldPrice) * 1000) / 10 : null;
    lines.push(
      `${money(alert.oldPrice)} → <b>${money(alert.newPrice)}</b>` +
        (pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""),
    );
  } else if (alert.newPrice !== null) {
    lines.push(`Цена: <b>${money(alert.newPrice)}</b>`);
  }

  lines.push(`https://www.wildberries.ru/catalog/${alert.nm}/detail.aspx`);
  return lines.join("\n");
}

/**
 * Рассылает накопившиеся уведомления. Вызывается планировщиком; отдельные сбои
 * не роняют пачку — сообщение просто останется недоставленным до следующего раза.
 */
export async function deliverPendingAlerts(limit = 30): Promise<number> {
  if (!isTelegramEnabled()) return 0;

  const pending = await db
    .select({
      id: alerts.id,
      type: alerts.type,
      oldPrice: alerts.oldPrice,
      newPrice: alerts.newPrice,
      nm: alerts.nm,
      name: products.name,
      supplierName: products.supplierName,
      chatId: userChannels.telegramChatId,
    })
    .from(alerts)
    .innerJoin(userChannels, eq(userChannels.userId, alerts.userId))
    .leftJoin(products, eq(products.nm, alerts.nm))
    .leftJoin(watches, eq(watches.id, alerts.watchId))
    .where(
      and(
        isNull(alerts.deliveredAt),
        eq(watches.notifyTelegram, true),
        isNotNull(userChannels.verifiedAt),
        // только события после подключения чата: иначе пользователь, привязавший
        // Telegram спустя неделю, получит разом всю накопившуюся ленту
        gte(alerts.createdAt, userChannels.verifiedAt),
      ),
    )
    .orderBy(asc(alerts.id))
    .limit(limit);

  let sent = 0;
  for (const alert of pending) {
    if (!alert.chatId) continue;
    try {
      await sendMessage(alert.chatId, formatAlert(alert));
      await db.update(alerts).set({ deliveredAt: new Date() }).where(eq(alerts.id, alert.id));
      sent += 1;
    } catch (error) {
      console.error("[telegram] не отправлено:", (error as Error).message);
    }
  }
  return sent;
}

// ── long polling для локальной разработки ────────────────────────────────────
let pollingOffset = 0;
let pollingActive = false;

export function startPolling(): void {
  if (!isTelegramEnabled() || pollingActive) return;
  pollingActive = true;

  const loop = async (): Promise<void> => {
    while (pollingActive) {
      try {
        const updates = await callApi<TelegramUpdate[]>("getUpdates", {
          offset: pollingOffset,
          timeout: 25,
        });
        for (const update of updates ?? []) {
          pollingOffset = update.update_id + 1;
          await handleUpdate(update);
        }
      } catch (error) {
        console.error("[telegram] polling:", (error as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
}

export function stopPolling(): void {
  pollingActive = false;
}

/** Регистрирует вебхук; используется, когда TELEGRAM_MODE=webhook. */
export async function registerWebhook(): Promise<void> {
  if (!isTelegramEnabled()) return;
  await callApi("setWebhook", { url: `${config.publicUrl}/api/telegram/webhook` });
}

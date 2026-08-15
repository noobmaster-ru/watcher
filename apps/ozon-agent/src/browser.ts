// Один долгоживущий headless Chromium, который проходит антибот-челлендж Озона
// (Variti) один раз и дальше дёргает composer-api изнутри открытой страницы —
// как расширение в живой вкладке. Порт browser.js из ozon-mcp-server.
//
// Ключевые решения оттуда, проверенные автором форка:
//  - главная страница остаётся открытой: все fetch идут из неё и наследуют
//    куки и origin пройденного челленджа;
//  - стили и картинки НЕ блокируются — челлендж грузит свои скрипты через них,
//    и обрыв этих запросов приводит к вечному 403;
//  - по простою браузер закрывается целиком, чтобы вернуть память: на сервере
//    её мало, а перезапуск с повторным челленджем стоит ~15 секунд раз в час.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const HOME = "https://www.ozon.ru/";
const API = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=";
const CHALLENGE_WAIT_MS = 12_000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 90_000;

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
];
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const log = (...args: unknown[]) => console.error("[browser]", ...args);

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let mainPage: Page | null = null;
let initPromise: Promise<void> | null = null;
let challenged = false;
let idleTimer: NodeJS.Timeout | null = null;

/** Когда браузер запускался и прошёл ли челлендж — для /health. */
export function browserStatus(): { running: boolean; challenged: boolean } {
  return { running: browser?.isConnected() ?? false, challenged };
}

function resetIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log("простой — закрываю браузер, чтобы вернуть память");
    void shutdown();
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

async function launch(): Promise<void> {
  log("запускаю Chromium…");
  browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  browser.on("disconnected", () => {
    log("браузер отвалился — перезапустится при следующем запросе");
    browser = null;
    context = null;
    mainPage = null;
    challenged = false;
  });

  context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: USER_AGENT,
    locale: "ru-RU",
  });
  challenged = false;
}

async function ensureContext(): Promise<void> {
  if (context && challenged) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!browser?.isConnected()) await launch();
    mainPage = await (context as BrowserContext).newPage();
    log("прохожу антибот-челлендж…");
    await mainPage.goto(HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await mainPage.waitForTimeout(CHALLENGE_WAIT_MS);
    const title = await mainPage.title();
    if (/antibot|ограничен|доступ/i.test(title)) {
      throw new Error(`челлендж не пройден (title: ${title})`);
    }
    challenged = true;
    log("челлендж пройден:", title.slice(0, 40));
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

const DEAD = /Target page, context or browser has been closed|Session closed|Connection closed|browser has been closed/i;

/**
 * composer-api для пути сайта (например «/product/123/»). fetch выполняется из
 * прошедшей челлендж страницы; чистый fetch без навигации безопасен даже
 * параллельно. На 403/307 (протухла сессия) — перезапуск с новым челленджем.
 */
export async function fetchComposer(path: string, retries = 1): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      resetIdle();
      await ensureContext();
      const body = await (mainPage as Page).evaluate(async (url: string) => {
        const response = await fetch(url, { headers: { accept: "application/json" } });
        return { status: response.status, text: await response.text() };
      }, API + encodeURIComponent(path));

      if (body.status !== 200) {
        if ((body.status === 403 || body.status === 307) && attempt < retries) {
          await shutdown();
          continue;
        }
        throw new Error(`Озон ответил HTTP ${body.status}`);
      }
      return JSON.parse(body.text);
    } catch (error) {
      if (DEAD.test(String((error as Error).message)) && attempt < retries) {
        await shutdown();
        continue;
      }
      throw error;
    }
  }
}

export async function shutdown(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  challenged = false;
  mainPage = null;
  try {
    await context?.close();
  } catch {
    /* уже закрыт */
  }
  try {
    await browser?.close();
  } catch {
    /* уже закрыт */
  }
  context = null;
  browser = null;
}

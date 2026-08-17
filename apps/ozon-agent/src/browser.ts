// Один настоящий Chrome с постоянным профилем, который живёт на сервере как
// обычный браузер человека. Ровно так устроен рабочий парсинг Озона у
// конкурентов: сессия, однажды прошедшая антибот руками, дальше отдаёт
// карточки неделями, а воркер дёргает composer-api изнутри открытой вкладки.
//
// Что здесь принципиально и почему:
//  - НЕ headless: антибот Озона режет безголовые сборки по отпечатку. Chrome
//    рисует окно в виртуальный экран Xvfb, а через noVNC в это окно можно
//    зайти глазами и пройти капчу — один раз, а не на каждом запуске;
//  - ПОСТОЯННЫЙ ПРОФИЛЬ (userDataDir на диске): куки антибота привязаны к
//    устройству, и переносить их нельзя — но если профиль тот же, IP тот же и
//    браузер тот же, Озон видит того же «человека»;
//  - челлендж НЕ проходится автоматически: если сессия протухла, агент честно
//    отвечает «нужен человек» и ждёт, а не долбится в стену, продлевая штраф;
//  - стили и картинки не блокируются: челлендж грузит свои скрипты через них,
//    и обрыв этих запросов приводит к вечному 403.

import { chromium, type BrowserContext, type Page } from "playwright";

const HOME = "https://www.ozon.ru/";
const API = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=";
const PROFILE_DIR = process.env.OZON_PROFILE_DIR ?? "/data/ozon-profile";
const NAV_TIMEOUT_MS = 90_000;
/** Сколько ждать после перехода, чтобы понять, отдал ли Озон страницу. */
const SETTLE_MS = 6_000;

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--window-size=1366,900",
  "--window-position=0,0",
];

const log = (...args: unknown[]) => console.error("[browser]", ...args);

/** Заглушки Озона: то, что он показывает непрошедшим проверку. */
const BLOCKED = /antibot|captcha|ограничен|нет соединения|что-то пошло не так/i;

/**
 * Прокси для Озона (OZON_PROXY). Профиль и прокси должны быть неразлучны:
 * кука антибота выдана на связку «браузер + IP», и смена прокси обнуляет
 * сессию так же, как смена профиля.
 */
function proxyFromEnv(): { server: string; username?: string; password?: string } | undefined {
  const raw = process.env.OZON_PROXY?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const proxy: { server: string; username?: string; password?: string } = {
      server: `${url.protocol}//${url.host}`,
    };
    if (url.username) proxy.username = decodeURIComponent(url.username);
    if (url.password) proxy.password = decodeURIComponent(url.password);
    return proxy;
  } catch {
    log("OZON_PROXY не разобран, работаю без прокси:", raw);
    return undefined;
  }
}

let context: BrowserContext | null = null;
let mainPage: Page | null = null;
let launching: Promise<void> | null = null;

export type SessionState = "down" | "needs_human" | "ready";
let sessionState: SessionState = "down";
let lastTitle = "";
let lastCheckAt: Date | null = null;

/** Состояние сессии — для /health и для сообщения в интерфейсе. */
export function browserStatus(): {
  running: boolean;
  session: SessionState;
  lastTitle: string;
  lastCheckAt: string | null;
  profileDir: string;
} {
  return {
    running: Boolean(context),
    session: sessionState,
    lastTitle,
    lastCheckAt: lastCheckAt?.toISOString() ?? null,
    profileDir: PROFILE_DIR,
  };
}

/** Поднимает Chrome с постоянным профилем. Идемпотентно. */
async function launch(): Promise<void> {
  if (context) return;
  if (launching) return launching;

  launching = (async () => {
    const proxy = proxyFromEnv();
    log("запускаю Chrome с профилем", PROFILE_DIR, proxy ? `через прокси ${proxy.server}` : "без прокси");
    // channel не задаём: в образе Playwright лежит полный Chromium, headless:false
    // рисует его в DISPLAY (Xvfb), который поднимает entrypoint.
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: LAUNCH_ARGS,
      proxy,
      viewport: null, // окно задаёт размер само — как у настоящего пользователя
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      ignoreDefaultArgs: ["--enable-automation"],
    });
    context.on("close", () => {
      log("браузер закрылся");
      context = null;
      mainPage = null;
      sessionState = "down";
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // Одна вкладка на всё: та же, в которую человек заходит через noVNC.
    mainPage = context.pages()[0] ?? (await context.newPage());
    sessionState = "down";
  })();

  try {
    await launching;
  } finally {
    launching = null;
  }
}

/**
 * Проверяет, жива ли сессия: открывает главную и смотрит заголовок. Никаких
 * повторных заходов — если стена, значит нужен человек, и об этом сообщается.
 */
export async function checkSession(): Promise<SessionState> {
  await launch();
  const page = mainPage as Page;
  try {
    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    lastTitle = await page.title();
  } catch (error) {
    lastTitle = `ошибка: ${(error as Error).message.slice(0, 80)}`;
  }
  lastCheckAt = new Date();
  sessionState = BLOCKED.test(lastTitle) || !lastTitle ? "needs_human" : "ready";
  log(sessionState === "ready" ? "сессия жива:" : "нужен человек:", lastTitle.slice(0, 50));
  return sessionState;
}

export class NeedsHumanError extends Error {
  constructor(title: string) {
    super(`Озон требует проверку человеком (${title.slice(0, 40)}). Откройте окно браузера агента и пройдите её.`);
    this.name = "NeedsHumanError";
  }
}

const DEAD = /Target page, context or browser has been closed|Session closed|Connection closed|browser has been closed/i;

/**
 * composer-api для пути сайта (например «/product/123/»). fetch выполняется из
 * открытой вкладки и наследует куки живой сессии. Если сессия впервые не
 * проверялась — проверяем; если Озон отвечает стеной — не ретраим, а честно
 * поднимаем NeedsHumanError.
 */
export async function fetchComposer(path: string): Promise<unknown> {
  await launch();
  if (sessionState !== "ready") {
    const state = await checkSession();
    if (state !== "ready") throw new NeedsHumanError(lastTitle);
  }

  try {
    const body = await (mainPage as Page).evaluate(async (url: string) => {
      const response = await fetch(url, { headers: { accept: "application/json" }, credentials: "include" });
      return { status: response.status, text: await response.text() };
    }, API + encodeURIComponent(path));

    if (body.status === 403 || body.status === 307) {
      // сессия протухла между проверками — переводим в «нужен человек», без ретраев
      sessionState = "needs_human";
      lastTitle = `HTTP ${body.status} на composer-api`;
      throw new NeedsHumanError(lastTitle);
    }
    if (body.status !== 200) throw new Error(`Озон ответил HTTP ${body.status}`);
    return JSON.parse(body.text);
  } catch (error) {
    if (DEAD.test(String((error as Error).message))) {
      context = null;
      mainPage = null;
      sessionState = "down";
    }
    throw error;
  }
}

/** Скриншот текущей вкладки — чтобы видеть, что перед человеком, не заходя в VNC. */
export async function screenshot(): Promise<Buffer | null> {
  if (!mainPage) return null;
  try {
    return await mainPage.screenshot({ type: "png" });
  } catch {
    return null;
  }
}

export async function shutdown(): Promise<void> {
  try {
    await context?.close();
  } catch {
    // уже закрыт
  }
  context = null;
  mainPage = null;
  sessionState = "down";
}

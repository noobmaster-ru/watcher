// Аутентификация: пароли на scrypt из стандартной библиотеки Node, сессии в БД.
//
// Почему scrypt, а не argon2: argon2 тянет нативный модуль, который нужно
// пересобирать под архитектуру сервера. scrypt встроен в Node, устойчив к
// перебору на GPU и не добавляет ни одной зависимости в образ.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
// побочный импорт: подключает типы request.cookies / reply.setCookie
import "@fastify/cookie";
import { db } from "./db/client.js";
import { sessions, users } from "./db/schema.js";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
export const SESSION_COOKIE = "watcher_session";

// ── пароли ───────────────────────────────────────────────────────────────────
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

// ── сессии ───────────────────────────────────────────────────────────────────
/** В БД лежит только хеш токена: дамп базы не даёт войти под пользователем. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function resolveSession(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Гасит все сессии пользователя, кроме текущей. Вызывается при смене пароля. */
export async function destroyOtherSessions(userId: number, keepToken: string | undefined): Promise<void> {
  const keep = keepToken ? hashToken(keepToken) : "";
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, keep)));
}

/** Чистка протухших сессий — вызывается планировщиком раз в сутки. */
export async function purgeExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

export interface AuthUser {
  id: number;
  email: string;
}

// ── интеграция с Fastify ─────────────────────────────────────────────────────
declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Хук: подкладывает request.user, но никого не отсекает. */
export async function loadUser(request: FastifyRequest): Promise<void> {
  request.user = await resolveSession(request.cookies[SESSION_COOKIE]);
}

/** preHandler для приватных маршрутов. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: "Нужна авторизация" });
  }
}

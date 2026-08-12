import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { config } from "../config.js";
import { AccountError, changeEmail } from "../services/account.js";
import type { GoogleApi } from "../services/google.js";
import {
  SESSION_COOKIE,
  destroyOtherSessions,
  requireAuth,
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  setSessionCookie,
  verifyPassword,
} from "../auth.js";

const credentials = z.object({
  email: z.string().email("Некорректный email").max(255),
  password: z.string().min(8, "Пароль от 8 символов").max(200),
});

export async function authRoutes(app: FastifyInstance, google: GoogleApi | null = null): Promise<void> {
  app.post("/api/auth/register", async (request, reply) => {
    if (!config.allowRegistration) {
      return reply.code(403).send({ error: "Регистрация закрыта" });
    }
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Некорректные данные" });
    }

    const email = parsed.data.email.toLowerCase().trim();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) return reply.code(409).send({ error: "Пользователь с таким email уже есть" });

    const [user] = await db
      .insert(users)
      .values({ email, passwordHash: await hashPassword(parsed.data.password) })
      .returning({ id: users.id, email: users.email });
    if (!user) return reply.code(500).send({ error: "Не удалось создать пользователя" });

    const session = await createSession(user.id);
    setSessionCookie(reply, session.token, session.expiresAt, config.cookieSecure);
    return reply.send({ user });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Введите email и пароль" });

    const email = parsed.data.email.toLowerCase().trim();
    const [user] = await db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // одинаковый ответ на «нет пользователя» и «неверный пароль» — чтобы по нему
    // нельзя было перебрать, кто зарегистрирован
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: "Неверный email или пароль" });
    }

    const session = await createSession(user.id);
    setSessionCookie(reply, session.token, session.expiresAt, config.cookieSecure);
    return reply.send({ user: { id: user.id, email: user.email } });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await destroySession(request.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.post("/api/auth/password", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z
      .object({ current: z.string().min(1), next: z.string().min(8, "Новый пароль от 8 символов").max(200) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Некорректные данные" });
    }

    const userId = request.user!.id;
    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || !(await verifyPassword(parsed.data.current, user.passwordHash))) {
      return reply.code(401).send({ error: "Текущий пароль неверен" });
    }

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(parsed.data.next) })
      .where(eq(users.id, userId));

    // остальные сессии гасим: сменил пароль — значит, чужой доступ надо оборвать
    await destroyOtherSessions(userId, request.cookies[SESSION_COOKIE]);
    return reply.send({ ok: true });
  });

  app.post("/api/auth/email", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z
      .object({ current: z.string().min(1), email: z.string().email("Некорректный email").max(255) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Некорректные данные" });
    }

    try {
      const result = await changeEmail(request.user!.id, parsed.data.current, parsed.data.email, google);
      return reply.send(result);
    } catch (error) {
      if (error instanceof AccountError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/me", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "Нужна авторизация" });
    return reply.send({ user: request.user, allowRegistration: config.allowRegistration });
  });
}

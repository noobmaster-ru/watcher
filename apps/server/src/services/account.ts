// Смена почты аккаунта.
//
// Гугл-таблицу смена почты не затрагивает: владеет ею сам пользователь, а
// пишет в неё сервисный аккаунт, который не меняется. Трогать права владельца
// файла было бы не только лишним, но и вредным — снять доступ у владельца
// нельзя, и попытка закончилась бы невнятной ошибкой.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyPassword } from "../auth.js";

export class AccountError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AccountError";
    this.status = status;
  }
}

export interface EmailChangeResult {
  email: string;
}

export async function changeEmail(
  userId: number,
  currentPassword: string,
  nextEmail: string,
): Promise<EmailChangeResult> {
  const email = nextEmail.trim().toLowerCase();

  const [user] = await db
    .select({ email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new AccountError(404, "Пользователь не найден");

  // Пароль спрашиваем именно здесь: смена почты уводит логин, и без проверки
  // любой, кто дорвался до открытой вкладки, забрал бы аккаунт себе.
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AccountError(401, "Текущий пароль неверен");
  }
  if (email === user.email) throw new AccountError(400, "Это и есть текущая почта");

  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (taken) throw new AccountError(409, "Такая почта уже занята");

  await db.update(users).set({ email }).where(eq(users.id, userId));
  return { email };
}

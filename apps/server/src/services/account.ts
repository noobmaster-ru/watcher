// Смена почты аккаунта.
//
// Почта — это и логин, и адрес, на который открыт доступ к Google Таблице.
// Поэтому смена затрагивает не только строку в базе: таблицу нужно переоткрыть
// на новый адрес и закрыть для старого, иначе прежняя почта сохранит доступ к
// данным аккаунта.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userSheets, users } from "../db/schema.js";
import { verifyPassword } from "../auth.js";
import type { GoogleApi } from "./google.js";

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
  /** Удалось ли переоткрыть доступ к таблице. */
  sheetUpdated: boolean;
  sheetError: string | null;
}

export async function changeEmail(
  userId: number,
  currentPassword: string,
  nextEmail: string,
  google: GoogleApi | null,
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

  // Доступ к таблице переносим отдельно и не роняем смену почты, если Google
  // отказал: почта уже сменилась, а права можно поправить следующей выгрузкой.
  const [sheet] = await db.select().from(userSheets).where(eq(userSheets.userId, userId)).limit(1);
  if (!sheet || !google) return { email, sheetUpdated: false, sheetError: null };

  try {
    await google.shareWithEmail(sheet.spreadsheetId, email);
    await google.unshareEmail(sheet.spreadsheetId, user.email);
    await google.renameSpreadsheet(sheet.spreadsheetId, `watcher — ${email}`);
    await db.update(userSheets).set({ lastError: null }).where(eq(userSheets.userId, userId));
    return { email, sheetUpdated: true, sheetError: null };
  } catch (error) {
    const message = (error as Error).message;
    await db.update(userSheets).set({ lastError: message }).where(eq(userSheets.userId, userId));
    return { email, sheetUpdated: false, sheetError: message };
  }
}

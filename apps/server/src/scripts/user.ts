#!/usr/bin/env node
// Управление пользователями из консоли. Нужно, когда регистрация в приложении
// закрыта (ALLOW_REGISTRATION=false) — на боевом стенде это нормальный режим.
//
//   node dist/scripts/user.js create user@example.com 'пароль'
//   node dist/scripts/user.js password user@example.com 'новый пароль'
//   node dist/scripts/user.js list

import { eq } from "drizzle-orm";
import { closeDb, db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../auth.js";

const [command, email, password] = process.argv.slice(2);

function usage(): never {
  console.error(`Использование:
  user create <email> <пароль>     создать пользователя
  user password <email> <пароль>   сменить пароль
  user email <старая> <новая>      сменить почту
  user list                        список пользователей`);
  process.exit(1);
}

try {
  switch (command) {
    case "create": {
      if (!email || !password) usage();
      if (password.length < 8) throw new Error("Пароль должен быть не короче 8 символов");
      const normalized = email.toLowerCase().trim();
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalized));
      if (existing) throw new Error(`Пользователь ${normalized} уже существует`);
      const [created] = await db
        .insert(users)
        .values({ email: normalized, passwordHash: await hashPassword(password) })
        .returning({ id: users.id });
      console.log(`Создан пользователь ${normalized} (id ${created?.id})`);
      break;
    }
    case "password": {
      if (!email || !password) usage();
      if (password.length < 8) throw new Error("Пароль должен быть не короче 8 символов");
      const [updated] = await db
        .update(users)
        .set({ passwordHash: await hashPassword(password) })
        .where(eq(users.email, email.toLowerCase().trim()))
        .returning({ id: users.id });
      if (!updated) throw new Error(`Пользователь ${email} не найден`);
      console.log(`Пароль для ${email} обновлён`);
      break;
    }
    case "email": {
      // здесь без переноса доступа к таблице: команда для аварийных случаев,
      // обычный путь — форма в настройках, она правит и права в Google
      if (!email || !password) usage();
      const next = password.toLowerCase().trim();
      const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, next));
      if (taken) throw new Error(`Почта ${next} уже занята`);
      const [updated] = await db
        .update(users)
        .set({ email: next })
        .where(eq(users.email, email.toLowerCase().trim()))
        .returning({ id: users.id });
      if (!updated) throw new Error(`Пользователь ${email} не найден`);
      console.log(`Почта изменена: ${email} → ${next}`);
      break;
    }
    case "list": {
      const rows = await db.select({ id: users.id, email: users.email, createdAt: users.createdAt }).from(users);
      if (rows.length === 0) console.log("Пользователей нет");
      for (const row of rows) console.log(`  ${row.id}\t${row.email}\t${row.createdAt.toISOString().slice(0, 10)}`);
      break;
    }
    default:
      usage();
  }
} catch (error) {
  console.error(`Ошибка: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

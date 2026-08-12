// Схема БД. Две вещи, определяющие форму данных:
//
// 1. `products` — общий справочник: один и тот же артикул может отслеживать
//    несколько пользователей, но опрашивается он один раз. Поэтому расписание
//    обхода (next_check_at) живёт на товаре, а не на подписке.
// 2. `price_points` пишется только при изменении цены или наличия плюс один
//    heartbeat в сутки. Писать каждую проверку — это миллионы строк в месяц
//    ради данных, которые и так восстанавливаются ступенькой.

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ── пользователи и доступ ────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: now(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    // хеш токена, не сам токен: утечка дампа БД не даёт войти под пользователем
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: now(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
);

// ── справочники Wildberries ──────────────────────────────────────────────────
export const sellers = pgTable("sellers", {
  supplierId: integer("supplier_id").primaryKey(),
  name: text("name"),
  fullName: text("full_name"),
  inn: text("inn"),
  trademark: text("trademark"),
  /** Когда последний раз обходили каталог и когда пойдём в следующий раз. */
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
  productCount: integer("product_count"),
  createdAt: now(),
});

export const products = pgTable(
  "products",
  {
    nm: bigint("nm", { mode: "number" }).primaryKey(),
    name: text("name"),
    brand: text("brand"),
    supplierId: integer("supplier_id"),
    supplierName: text("supplier_name"),
    /** imtId: по нему лежат отзывы. */
    root: bigint("root", { mode: "number" }),
    pics: integer("pics"),
    rating: real("rating"),
    reviews: integer("reviews"),

    // денормализованное последнее состояние — чтобы сравнивать без запроса в price_points
    lastPrice: integer("last_price"),
    lastBasic: integer("last_basic"),
    lastInStock: boolean("last_in_stock"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** Момент последней записи в историю: нужен для суточного heartbeat. */
    lastPointAt: timestamp("last_point_at", { withTimezone: true }),

    // расписание обхода
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    checkIntervalMin: integer("check_interval_min").notNull().default(60),
    /** Подряд идущие неудачи: после серии товар опрашивается реже. */
    errorCount: integer("error_count").notNull().default(0),
    /** Товар опрашивается, только пока на него есть хоть одна активная подписка. */
    isTracked: boolean("is_tracked").notNull().default(false),
    createdAt: now(),
  },
  (t) => ({
    // частичный индекс: планировщик читает только отслеживаемые товары
    scheduleIdx: index("products_schedule_idx").on(t.nextCheckAt).where(sql`${t.isTracked}`),
    supplierIdx: index("products_supplier_idx").on(t.supplierId),
  }),
);

/** Состав каталога продавца: нужен, чтобы замечать появление новых товаров. */
export const sellerProducts = pgTable(
  "seller_products",
  {
    supplierId: integer("supplier_id").notNull(),
    nm: bigint("nm", { mode: "number" }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.supplierId, t.nm] }),
    nmIdx: index("seller_products_nm_idx").on(t.nm),
  }),
);

// ── история цен ──────────────────────────────────────────────────────────────
export const pricePoints = pgTable(
  "price_points",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nm: bigint("nm", { mode: "number" }).notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    /** Цена к оплате. null означает «товара нет в продаже», а не ноль. */
    price: integer("price"),
    basic: integer("basic"),
    priceMin: integer("price_min"),
    priceMax: integer("price_max"),
    cashback: integer("cashback"),
    inStock: boolean("in_stock").notNull(),
    quantity: integer("quantity"),
    /** Регион и скидка, при которых снята цена: без них история несравнима. */
    dest: text("dest").notNull(),
    spp: integer("spp"),
  },
  (t) => ({
    historyIdx: index("price_points_nm_checked_idx").on(t.nm, t.checkedAt),
  }),
);

/**
 * Ежедневный срез по продавцу. История цен есть у каждого товара, но по
 * продавцу целиком её собрать неоткуда: каталог меняется, товары появляются и
 * исчезают. Срез отвечает на вопрос «что было у продавца на такую-то дату».
 */
export const sellerSnapshots = pgTable(
  "seller_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    supplierId: integer("supplier_id").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    productCount: integer("product_count").notNull(),
    inStockCount: integer("in_stock_count").notNull(),
    minPrice: integer("min_price"),
    maxPrice: integer("max_price"),
    avgPrice: integer("avg_price"),
  },
  (t) => ({
    historyIdx: index("seller_snapshots_supplier_idx").on(t.supplierId, t.capturedAt),
  }),
);

// ── ключевые слова и позиции ──────────────────────────────────────────────────
/** Поисковый запрос, по которому отслеживаются позиции товаров пользователя. */
export const keywords = pgTable(
  "keywords",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    phrase: text("phrase").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Сколько страниц выдачи просматривать: на странице 100 товаров. По
     * умолчанию одна — каждая следующая это отдельный запрос к search.wb.ru,
     * самому строгому хосту Wildberries.
     */
    maxPages: integer("max_pages").notNull().default(1),
    intervalMin: integer("interval_min").notNull().default(360),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** Сколько всего товаров WB отдал по запросу в последний раз. */
    lastTotal: integer("last_total"),
    errorCount: integer("error_count").notNull().default(0),
    createdAt: now(),
  },
  (t) => ({
    userIdx: index("keywords_user_idx").on(t.userId),
    scheduleIdx: index("keywords_schedule_idx").on(t.nextCheckAt).where(sql`${t.isActive}`),
    uniquePhrase: uniqueIndex("keywords_user_phrase_idx").on(t.userId, t.phrase),
  }),
);

/**
 * Позиция товара в выдаче по запросу. position = null означает, что товар из
 * выдачи выпал: такие строки пишутся только для тех артикулов, что были найдены
 * в прошлый раз, иначе на каждую проверку добавлялись бы сотни пустых строк.
 */
export const keywordPositions = pgTable(
  "keyword_positions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    keywordId: integer("keyword_id")
      .notNull()
      .references(() => keywords.id, { onDelete: "cascade" }),
    nm: bigint("nm", { mode: "number" }).notNull(),
    position: integer("position"),
    page: integer("page"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    historyIdx: index("keyword_positions_keyword_checked_idx").on(t.keywordId, t.checkedAt),
    nmIdx: index("keyword_positions_nm_idx").on(t.nm),
  }),
);

// ── выгрузка в Google Таблицы ────────────────────────────────────────────────
/**
 * Таблица пользователя. Курсоры хранят, до какой строки данные уже выгружены:
 * при каждом прогоне дописываются только новые, иначе таблица переписывалась бы
 * целиком и быстро упёрлась бы в квоты Google.
 */
export const userSheets = pgTable("user_sheets", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  spreadsheetId: text("spreadsheet_id").notNull(),
  spreadsheetUrl: text("spreadsheet_url").notNull(),
  cursorPricePoint: bigint("cursor_price_point", { mode: "number" }).notNull().default(0),
  cursorKeywordPosition: bigint("cursor_keyword_position", { mode: "number" }).notNull().default(0),
  cursorSellerSnapshot: bigint("cursor_seller_snapshot", { mode: "number" }).notNull().default(0),
  lastExportAt: timestamp("last_export_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: now(),
});

// ── подписки и уведомления ───────────────────────────────────────────────────
export const watchKinds = ["product", "seller"] as const;
export type WatchKind = (typeof watchKinds)[number];

export const watches = pgTable(
  "watches",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<WatchKind>(),
    /** Заполнено для kind='product'. */
    nm: bigint("nm", { mode: "number" }),
    /** Заполнено для kind='seller'. */
    supplierId: integer("supplier_id"),
    title: text("title"),
    intervalMin: integer("interval_min").notNull().default(60),
    isActive: boolean("is_active").notNull().default(true),

    // правила срабатывания: порог отсекает копеечные шевеления цены
    minChangePct: real("min_change_pct").notNull().default(1),
    minChangeAbs: integer("min_change_abs").notNull().default(0),
    onDrop: boolean("on_drop").notNull().default(true),
    onRise: boolean("on_rise").notNull().default(false),
    onStockChange: boolean("on_stock_change").notNull().default(true),
    onNewProduct: boolean("on_new_product").notNull().default(true),

    createdAt: now(),
  },
  (t) => ({
    userIdx: index("watches_user_idx").on(t.userId),
    nmIdx: index("watches_nm_idx").on(t.nm),
    supplierIdx: index("watches_supplier_idx").on(t.supplierId),
    // одна подписка на объект у одного пользователя
    uniqueProduct: uniqueIndex("watches_user_nm_idx")
      .on(t.userId, t.nm)
      .where(sql`${t.nm} is not null`),
    uniqueSeller: uniqueIndex("watches_user_supplier_idx")
      .on(t.userId, t.supplierId)
      .where(sql`${t.supplierId} is not null`),
  }),
);

export const alertTypes = [
  "price_drop",
  "price_rise",
  "out_of_stock",
  "back_in_stock",
  "new_product",
] as const;
export type AlertType = (typeof alertTypes)[number];

export const alerts = pgTable(
  "alerts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    watchId: integer("watch_id").references(() => watches.id, { onDelete: "cascade" }),
    nm: bigint("nm", { mode: "number" }).notNull(),
    type: text("type").notNull().$type<AlertType>(),
    oldPrice: integer("old_price"),
    newPrice: integer("new_price"),
    createdAt: now(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => ({
    feedIdx: index("alerts_user_created_idx").on(t.userId, t.createdAt),
  }),
);

// ── связи ────────────────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ many }) => ({
  watches: many(watches),
  alerts: many(alerts),
}));

export const watchesRelations = relations(watches, ({ one }) => ({
  user: one(users, { fields: [watches.userId], references: [users.id] }),
  product: one(products, { fields: [watches.nm], references: [products.nm] }),
  seller: one(sellers, { fields: [watches.supplierId], references: [sellers.supplierId] }),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  user: one(users, { fields: [alerts.userId], references: [users.id] }),
  product: one(products, { fields: [alerts.nm], references: [products.nm] }),
  watch: one(watches, { fields: [alerts.watchId], references: [watches.id] }),
}));

export const keywordsRelations = relations(keywords, ({ one, many }) => ({
  user: one(users, { fields: [keywords.userId], references: [users.id] }),
  positions: many(keywordPositions),
}));

export const keywordPositionsRelations = relations(keywordPositions, ({ one }) => ({
  keyword: one(keywords, { fields: [keywordPositions.keywordId], references: [keywords.id] }),
  product: one(products, { fields: [keywordPositions.nm], references: [products.nm] }),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  seller: one(sellers, { fields: [products.supplierId], references: [sellers.supplierId] }),
  points: many(pricePoints),
}));

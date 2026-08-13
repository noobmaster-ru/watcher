CREATE TABLE "ym_price_points" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"price" integer,
	"in_stock" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ym_products" (
	"sku" text PRIMARY KEY NOT NULL,
	"name" text,
	"image" text,
	"url" text,
	"description" text,
	"last_price" integer,
	"last_in_stock" boolean,
	"last_checked_at" timestamp with time zone,
	"last_point_at" timestamp with time zone,
	"is_tracked" boolean DEFAULT false NOT NULL,
	"check_interval_min" integer DEFAULT 60 NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ym_watches" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"sku" text NOT NULL,
	"title" text,
	"interval_min" integer DEFAULT 60 NOT NULL,
	"min_change_pct" integer DEFAULT 1 NOT NULL,
	"min_change_abs" integer DEFAULT 0 NOT NULL,
	"on_drop" boolean DEFAULT true NOT NULL,
	"on_rise" boolean DEFAULT false NOT NULL,
	"on_stock_change" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "ym_watch_id" integer;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "marketplace" text DEFAULT 'wb' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sheets" ADD COLUMN "marketplace" text DEFAULT 'wb' NOT NULL;--> statement-breakpoint
-- Первичный ключ был по одному user_id; теперь у пользователя своя таблица на
-- каждую площадку, поэтому ключ становится составным. Порядок важен: колонка
-- должна появиться раньше ключа, а имя старого ограничения drizzle оставляет
-- заглушкой — оно взято с боевой базы.
ALTER TABLE "user_sheets" DROP CONSTRAINT "user_sheets_pkey";--> statement-breakpoint
ALTER TABLE "user_sheets" ADD CONSTRAINT "user_sheets_user_id_marketplace_pk" PRIMARY KEY("user_id","marketplace");--> statement-breakpoint
ALTER TABLE "ym_price_points" ADD CONSTRAINT "ym_price_points_sku_ym_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."ym_products"("sku") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ym_watches" ADD CONSTRAINT "ym_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ym_watches" ADD CONSTRAINT "ym_watches_sku_ym_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."ym_products"("sku") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ym_price_points_sku_checked_idx" ON "ym_price_points" USING btree ("sku","checked_at");--> statement-breakpoint
CREATE INDEX "ym_products_schedule_idx" ON "ym_products" USING btree ("next_check_at") WHERE "ym_products"."is_tracked";--> statement-breakpoint
CREATE INDEX "ym_watches_user_idx" ON "ym_watches" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ym_watches_user_sku_idx" ON "ym_watches" USING btree ("user_id","sku");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_ym_watch_id_ym_watches_id_fk" FOREIGN KEY ("ym_watch_id") REFERENCES "public"."ym_watches"("id") ON DELETE cascade ON UPDATE no action;
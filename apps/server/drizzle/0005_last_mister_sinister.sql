CREATE TABLE "ozon_price_points" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"price" integer,
	"card_price" integer,
	"in_stock" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ozon_products" (
	"sku" text PRIMARY KEY NOT NULL,
	"name" text,
	"image" text,
	"url" text,
	"last_price" integer,
	"last_card_price" integer,
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
CREATE TABLE "ozon_watches" (
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
ALTER TABLE "alerts" ADD COLUMN "ozon_watch_id" integer;--> statement-breakpoint
ALTER TABLE "ozon_price_points" ADD CONSTRAINT "ozon_price_points_sku_ozon_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."ozon_products"("sku") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ozon_watches" ADD CONSTRAINT "ozon_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ozon_watches" ADD CONSTRAINT "ozon_watches_sku_ozon_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."ozon_products"("sku") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ozon_price_points_sku_checked_idx" ON "ozon_price_points" USING btree ("sku","checked_at");--> statement-breakpoint
CREATE INDEX "ozon_products_schedule_idx" ON "ozon_products" USING btree ("next_check_at") WHERE "ozon_products"."is_tracked";--> statement-breakpoint
CREATE INDEX "ozon_watches_user_idx" ON "ozon_watches" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ozon_watches_user_sku_idx" ON "ozon_watches" USING btree ("user_id","sku");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_ozon_watch_id_ozon_watches_id_fk" FOREIGN KEY ("ozon_watch_id") REFERENCES "public"."ozon_watches"("id") ON DELETE cascade ON UPDATE no action;
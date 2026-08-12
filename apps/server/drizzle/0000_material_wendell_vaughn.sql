CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"watch_id" integer,
	"nm" bigint NOT NULL,
	"type" text NOT NULL,
	"old_price" integer,
	"new_price" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "price_points" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"nm" bigint NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"price" integer,
	"basic" integer,
	"price_min" integer,
	"price_max" integer,
	"cashback" integer,
	"in_stock" boolean NOT NULL,
	"quantity" integer,
	"dest" text NOT NULL,
	"spp" integer
);
--> statement-breakpoint
CREATE TABLE "products" (
	"nm" bigint PRIMARY KEY NOT NULL,
	"name" text,
	"brand" text,
	"supplier_id" integer,
	"supplier_name" text,
	"root" bigint,
	"pics" integer,
	"rating" real,
	"reviews" integer,
	"last_price" integer,
	"last_basic" integer,
	"last_in_stock" boolean,
	"last_checked_at" timestamp with time zone,
	"last_point_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_interval_min" integer DEFAULT 60 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"is_tracked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_products" (
	"supplier_id" integer NOT NULL,
	"nm" bigint NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "seller_products_supplier_id_nm_pk" PRIMARY KEY("supplier_id","nm")
);
--> statement-breakpoint
CREATE TABLE "sellers" (
	"supplier_id" integer PRIMARY KEY NOT NULL,
	"name" text,
	"full_name" text,
	"inn" text,
	"trademark" text,
	"last_synced_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"product_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_channels" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"telegram_chat_id" text,
	"bind_token" text,
	"bind_token_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"nm" bigint,
	"supplier_id" integer,
	"title" text,
	"interval_min" integer DEFAULT 60 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"min_change_pct" real DEFAULT 1 NOT NULL,
	"min_change_abs" integer DEFAULT 0 NOT NULL,
	"on_drop" boolean DEFAULT true NOT NULL,
	"on_rise" boolean DEFAULT false NOT NULL,
	"on_stock_change" boolean DEFAULT true NOT NULL,
	"on_new_product" boolean DEFAULT true NOT NULL,
	"notify_telegram" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_watch_id_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_user_created_idx" ON "alerts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "alerts_undelivered_idx" ON "alerts" USING btree ("delivered_at");--> statement-breakpoint
CREATE INDEX "price_points_nm_checked_idx" ON "price_points" USING btree ("nm","checked_at");--> statement-breakpoint
CREATE INDEX "products_schedule_idx" ON "products" USING btree ("next_check_at") WHERE "products"."is_tracked";--> statement-breakpoint
CREATE INDEX "products_supplier_idx" ON "products" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "seller_products_nm_idx" ON "seller_products" USING btree ("nm");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "watches_user_idx" ON "watches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "watches_nm_idx" ON "watches" USING btree ("nm");--> statement-breakpoint
CREATE INDEX "watches_supplier_idx" ON "watches" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watches_user_nm_idx" ON "watches" USING btree ("user_id","nm") WHERE "watches"."nm" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "watches_user_supplier_idx" ON "watches" USING btree ("user_id","supplier_id") WHERE "watches"."supplier_id" is not null;
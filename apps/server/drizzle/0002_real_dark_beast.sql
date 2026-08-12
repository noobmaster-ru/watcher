CREATE TABLE "keyword_positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"keyword_id" integer NOT NULL,
	"nm" bigint NOT NULL,
	"position" integer,
	"page" integer,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"phrase" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"max_pages" integer DEFAULT 3 NOT NULL,
	"interval_min" integer DEFAULT 360 NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_total" integer,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_count" integer NOT NULL,
	"in_stock_count" integer NOT NULL,
	"min_price" integer,
	"max_price" integer,
	"avg_price" integer
);
--> statement-breakpoint
CREATE TABLE "user_sheets" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"spreadsheet_url" text NOT NULL,
	"cursor_price_point" bigint DEFAULT 0 NOT NULL,
	"cursor_keyword_position" bigint DEFAULT 0 NOT NULL,
	"cursor_seller_snapshot" bigint DEFAULT 0 NOT NULL,
	"last_export_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "keyword_positions" ADD CONSTRAINT "keyword_positions_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sheets" ADD CONSTRAINT "user_sheets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "keyword_positions_keyword_checked_idx" ON "keyword_positions" USING btree ("keyword_id","checked_at");--> statement-breakpoint
CREATE INDEX "keyword_positions_nm_idx" ON "keyword_positions" USING btree ("nm");--> statement-breakpoint
CREATE INDEX "keywords_user_idx" ON "keywords" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "keywords_schedule_idx" ON "keywords" USING btree ("next_check_at") WHERE "keywords"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "keywords_user_phrase_idx" ON "keywords" USING btree ("user_id","phrase");--> statement-breakpoint
CREATE INDEX "seller_snapshots_supplier_idx" ON "seller_snapshots" USING btree ("supplier_id","captured_at");
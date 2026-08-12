ALTER TABLE "user_channels" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "user_channels" CASCADE;--> statement-breakpoint
DROP INDEX "alerts_undelivered_idx";--> statement-breakpoint
ALTER TABLE "alerts" DROP COLUMN "delivered_at";--> statement-breakpoint
ALTER TABLE "watches" DROP COLUMN "notify_telegram";
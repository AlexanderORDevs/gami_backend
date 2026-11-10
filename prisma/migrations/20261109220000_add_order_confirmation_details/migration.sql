ALTER TABLE "order_items" ADD COLUMN "confirmed_quantity" INTEGER;
ALTER TABLE "inventory" ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_confirmed_quantity_valid"
CHECK ("confirmed_quantity" IS NULL OR "confirmed_quantity" BETWEEN 0 AND "quantity");

ALTER TABLE "fulfillment_exceptions"
  ADD COLUMN "review_note" TEXT,
  ADD COLUMN "reviewed_by_id" UUID,
  ADD COLUMN "reviewed_at" TIMESTAMP(3);

ALTER TABLE "fulfillment_exceptions"
  ADD CONSTRAINT "fulfillment_exceptions_reviewed_by_id_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
INSERT INTO "roles" ("id", "code", "name", "description", "system", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'CUSTOMER', 'Cliente', 'Public customer account without platform or store privileges', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

CREATE TABLE "customer_cart_items" (
  "customer_id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 1000000),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customer_cart_items_pkey" PRIMARY KEY ("customer_id", "variant_id"),
  CONSTRAINT "customer_cart_items_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "customer_cart_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "customer_favorites" (
  "customer_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_favorites_pkey" PRIMARY KEY ("customer_id", "product_id"),
  CONSTRAINT "customer_favorites_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "customer_favorites_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PARTIALLY_CONFIRMED', 'CONFIRMED', 'CANCELLED', 'FULFILLING', 'DELIVERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "StoreOrderStatus" AS ENUM ('PENDING_CONFIRMATION', 'PRE_CONFIRMED', 'CONFIRMED', 'PARTIALLY_CONFIRMED', 'REJECTED', 'CANCELLED', 'PICKED_UP', 'QUALITY_CONTROL', 'READY_FOR_SHIPMENT', 'DELIVERED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "CommercialModel" AS ENUM ('AGENCY', 'RESELLER');

-- CreateEnum
CREATE TYPE "ConfirmationChannel" AS ENUM ('WHATSAPP', 'STORE_PANEL', 'ADMIN_PANEL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('INITIAL', 'ADJUSTMENT', 'RESTOCK', 'SALE', 'RELEASE', 'RETURN');

-- CreateEnum
CREATE TYPE "StockHoldStatus" AS ENUM ('LIVE', 'FIRM', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "AddressZoneType" AS ENUM ('LIMA', 'PROVINCE', 'AGENCY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'READY_FOR_PICKUP', 'PICKED_UP', 'CONSOLIDATING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "MessageClassification" AS ENUM ('CONFIRM', 'REJECT', 'PARTIAL', 'AMBIGUOUS', 'OTHER');

-- CreateEnum
CREATE TYPE "FulfillmentExceptionType" AS ENUM ('NO_RESPONSE', 'OUT_OF_STOCK', 'ITEM_MISMATCH', 'DAMAGED_ITEM', 'QUALITY_REJECTED', 'COURIER_LOSS', 'DELIVERY_FAILED', 'OTHER');

-- CreateEnum
CREATE TYPE "ExceptionResolution" AS ENUM ('ALTERNATIVE_OFFERED', 'PARTIAL_CONFIRMATION', 'REFUND', 'CUSTOMER_CREDIT', 'REPLACEMENT', 'PROMISE_DEGRADATION', 'SUSPENSION_CANCELLATION', 'INTERNAL_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StrikeType" AS ENUM ('NO_RESPONSE', 'FAILURE_AFTER_CONFIRMATION', 'ITEM_MISMATCH', 'DAMAGED_ITEM', 'POST_DELIVERY_DEFECT', 'FAILED_STOCK_DECLARATION');

-- CreateEnum
CREATE TYPE "StrikeStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'AVAILABLE', 'SCHEDULED', 'PAID', 'HELD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('DRAFT', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('SALE', 'COMMISSION', 'PAYOUT', 'REFUND', 'COMPENSATION', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CompensationType" AS ENUM ('REFUND', 'CUSTOMER_CREDIT', 'REPLACEMENT', 'INTERNAL_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CompensationStatus" AS ENUM ('PENDING', 'APPROVED', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "IntegrationEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "AuditChannel" AS ENUM ('API', 'CUSTOMER_APP', 'STORE_PANEL', 'ADMIN_PANEL', 'WHATSAPP', 'WEBHOOK', 'SCHEDULED_JOB', 'SYSTEM');

-- CreateTable
CREATE TABLE "store_members" (
    "user_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_members_pkey" PRIMARY KEY ("user_id","store_id")
);

-- CreateTable
CREATE TABLE "store_hours" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "opens_at" TIME(0) NOT NULL,
    "closes_at" TIME(0) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_closures" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "reason" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_attributes" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "value" VARCHAR(180) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "full_name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(180),
    "phone" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "label" VARCHAR(80),
    "recipient_name" VARCHAR(150) NOT NULL,
    "recipient_phone" VARCHAR(30) NOT NULL,
    "zone_type" "AddressZoneType" NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "district" VARCHAR(100),
    "agency" VARCHAR(150),
    "line1" VARCHAR(255) NOT NULL,
    "reference" VARCHAR(255),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" VARCHAR(30) NOT NULL,
    "customer_id" UUID NOT NULL,
    "shipping_address_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "subtotal_in_cents" INTEGER NOT NULL,
    "shipping_in_cents" INTEGER NOT NULL,
    "discount_in_cents" INTEGER NOT NULL DEFAULT 0,
    "total_in_cents" INTEGER NOT NULL,
    "promised_delivery_start_at" TIMESTAMP(3),
    "promised_delivery_end_at" TIMESTAMP(3),
    "placed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_orders" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "status" "StoreOrderStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "commercial_model" "CommercialModel" NOT NULL DEFAULT 'AGENCY',
    "commission_rate_basis_points" INTEGER,
    "subtotal_in_cents" INTEGER NOT NULL,
    "commission_in_cents" INTEGER,
    "net_amount_in_cents" INTEGER,
    "confirmation_channel" "ConfirmationChannel",
    "confirmed_by_id" UUID,
    "confirmation_requested_at" TIMESTAMP(3),
    "confirmation_due_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "store_order_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_name" VARCHAR(180) NOT NULL,
    "sku" VARCHAR(80) NOT NULL,
    "size_label" VARCHAR(30) NOT NULL,
    "color" VARCHAR(60) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_in_cents" INTEGER NOT NULL,
    "total_in_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "order_item_id" UUID,
    "actor_user_id" UUID,
    "type" "StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "reason" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_holds" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_item_id" UUID,
    "quantity" INTEGER NOT NULL,
    "status" "StockHoldStatus" NOT NULL DEFAULT 'LIVE',
    "expires_at" TIMESTAMP(3),
    "firmed_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_declarations" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "declared_by_id" UUID NOT NULL,
    "declared_quantity" INTEGER NOT NULL,
    "overnight_limit" INTEGER NOT NULL,
    "declared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" VARCHAR(60) NOT NULL,
    "provider_payment_id" VARCHAR(180),
    "idempotency_key" VARCHAR(180) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount_in_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "authorized_at" TIMESTAMP(3),
    "captured_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "provider_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "method" VARCHAR(60) NOT NULL,
    "provider" VARCHAR(80),
    "tracking_code" VARCHAR(120),
    "shipping_rate_in_cents" INTEGER NOT NULL,
    "pickup_scheduled_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "dispatched_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "provider_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "store_order_id" UUID NOT NULL,
    "provider_message_id" VARCHAR(180),
    "direction" "MessageDirection" NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "template_name" VARCHAR(120),
    "body" TEXT,
    "raw_response" TEXT,
    "classification" "MessageClassification",
    "provider_data" JSONB,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_exceptions" (
    "id" UUID NOT NULL,
    "store_order_id" UUID NOT NULL,
    "type" "FulfillmentExceptionType" NOT NULL,
    "description" TEXT NOT NULL,
    "affected_items" JSONB,
    "evidence" JSONB,
    "resolution" "ExceptionResolution",
    "resolution_note" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fulfillment_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strikes" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "source_store_order_id" UUID,
    "created_by_id" UUID,
    "type" "StrikeType" NOT NULL,
    "status" "StrikeStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "evidence" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strikes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appeals" (
    "id" UUID NOT NULL,
    "strike_id" UUID NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'PENDING',
    "statement" TEXT NOT NULL,
    "evidence" JSONB,
    "reviewed_by_id" UUID,
    "resolution_note" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'DRAFT',
    "amount_in_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "payment_reference" VARCHAR(180),
    "receipt_url" VARCHAR(500),
    "marked_by_id" UUID,
    "scheduled_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_settlements" (
    "id" UUID NOT NULL,
    "store_order_id" UUID NOT NULL,
    "payout_id" UUID,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "gross_amount_in_cents" INTEGER NOT NULL,
    "commission_in_cents" INTEGER NOT NULL,
    "net_amount_in_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "available_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "store_order_id" UUID,
    "payout_id" UUID,
    "type" "LedgerEntryType" NOT NULL,
    "amount_in_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "idempotency_key" VARCHAR(180) NOT NULL,
    "description" VARCHAR(255),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensations" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "type" "CompensationType" NOT NULL,
    "status" "CompensationStatus" NOT NULL DEFAULT 'PENDING',
    "amount_in_cents" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "reason" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compensations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_credits" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "amount_in_cents" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "idempotency_key" VARCHAR(180) NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "description" VARCHAR(255),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "logistics_calendar" (
    "date" DATE NOT NULL,
    "is_working_day" BOOLEAN NOT NULL,
    "description" VARCHAR(180),

    CONSTRAINT "logistics_calendar_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "shipping_rates" (
    "id" UUID NOT NULL,
    "zone_type" "AddressZoneType" NOT NULL,
    "district" VARCHAR(100),
    "min_items" INTEGER NOT NULL DEFAULT 1,
    "max_items" INTEGER,
    "rate_in_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PEN',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipping_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_events" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "session_id" VARCHAR(120) NOT NULL,
    "event_name" VARCHAR(100) NOT NULL,
    "properties" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(60) NOT NULL,
    "external_event_id" VARCHAR(180) NOT NULL,
    "event_type" VARCHAR(120) NOT NULL,
    "status" "IntegrationEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_user_id" UUID,
    "entity_type" VARCHAR(80) NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "from_state" VARCHAR(80),
    "to_state" VARCHAR(80),
    "channel" "AuditChannel" NOT NULL,
    "reason" VARCHAR(255),
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_members_store_id_active_idx" ON "store_members"("store_id", "active");

-- CreateIndex
CREATE INDEX "store_hours_store_id_day_of_week_idx" ON "store_hours"("store_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "store_hours_store_id_day_of_week_opens_at_key" ON "store_hours"("store_id", "day_of_week", "opens_at");

-- CreateIndex
CREATE INDEX "store_closures_store_id_starts_at_ends_at_idx" ON "store_closures"("store_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "product_attributes_code_value_idx" ON "product_attributes"("code", "value");

-- CreateIndex
CREATE UNIQUE INDEX "product_attributes_product_id_code_value_key" ON "product_attributes"("product_id", "code", "value");

-- CreateIndex
CREATE UNIQUE INDEX "customers_user_id_key" ON "customers"("user_id");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_email_idx" ON "customers"("email");

-- CreateIndex
CREATE INDEX "customers_deleted_at_idx" ON "customers"("deleted_at");

-- CreateIndex
CREATE INDEX "addresses_customer_id_is_default_idx" ON "addresses"("customer_id", "is_default");

-- CreateIndex
CREATE INDEX "addresses_deleted_at_idx" ON "addresses"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "store_orders_store_id_status_confirmation_due_at_idx" ON "store_orders"("store_id", "status", "confirmation_due_at");

-- CreateIndex
CREATE INDEX "store_orders_status_created_at_idx" ON "store_orders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_orders_order_id_store_id_key" ON "store_orders"("order_id", "store_id");

-- CreateIndex
CREATE INDEX "order_items_store_order_id_idx" ON "order_items"("store_order_id");

-- CreateIndex
CREATE INDEX "order_items_variant_id_idx" ON "order_items"("variant_id");

-- CreateIndex
CREATE INDEX "stock_movements_variant_id_created_at_idx" ON "stock_movements"("variant_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_order_item_id_idx" ON "stock_movements"("order_item_id");

-- CreateIndex
CREATE INDEX "stock_holds_variant_id_status_expires_at_idx" ON "stock_holds"("variant_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "stock_holds_order_id_idx" ON "stock_holds"("order_id");

-- CreateIndex
CREATE INDEX "stock_declarations_variant_id_declared_at_idx" ON "stock_declarations"("variant_id", "declared_at");

-- CreateIndex
CREATE INDEX "stock_declarations_expires_at_idx" ON "stock_declarations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_order_id_key" ON "shipments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tracking_code_key" ON "shipments"("tracking_code");

-- CreateIndex
CREATE INDEX "shipments_status_created_at_idx" ON "shipments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_provider_message_id_key" ON "whatsapp_messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_store_order_id_created_at_idx" ON "whatsapp_messages"("store_order_id", "created_at");

-- CreateIndex
CREATE INDEX "whatsapp_messages_status_created_at_idx" ON "whatsapp_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "fulfillment_exceptions_store_order_id_resolved_at_idx" ON "fulfillment_exceptions"("store_order_id", "resolved_at");

-- CreateIndex
CREATE INDEX "fulfillment_exceptions_type_created_at_idx" ON "fulfillment_exceptions"("type", "created_at");

-- CreateIndex
CREATE INDEX "strikes_store_id_status_expires_at_idx" ON "strikes"("store_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "strikes_source_store_order_id_idx" ON "strikes"("source_store_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "appeals_strike_id_key" ON "appeals"("strike_id");

-- CreateIndex
CREATE INDEX "appeals_status_submitted_at_idx" ON "appeals"("status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_payment_reference_key" ON "payouts"("payment_reference");

-- CreateIndex
CREATE INDEX "payouts_store_id_status_created_at_idx" ON "payouts"("store_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pending_settlements_store_order_id_key" ON "pending_settlements"("store_order_id");

-- CreateIndex
CREATE INDEX "pending_settlements_status_available_at_idx" ON "pending_settlements"("status", "available_at");

-- CreateIndex
CREATE INDEX "pending_settlements_payout_id_idx" ON "pending_settlements"("payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_key" ON "ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_entries_store_id_created_at_idx" ON "ledger_entries"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_store_order_id_idx" ON "ledger_entries"("store_order_id");

-- CreateIndex
CREATE INDEX "ledger_entries_payout_id_idx" ON "ledger_entries"("payout_id");

-- CreateIndex
CREATE INDEX "compensations_order_item_id_status_idx" ON "compensations"("order_item_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_credits_idempotency_key_key" ON "customer_credits"("idempotency_key");

-- CreateIndex
CREATE INDEX "customer_credits_customer_id_created_at_idx" ON "customer_credits"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_credits_order_id_idx" ON "customer_credits"("order_id");

-- CreateIndex
CREATE INDEX "shipping_rates_zone_type_district_active_idx" ON "shipping_rates"("zone_type", "district", "active");

-- CreateIndex
CREATE INDEX "user_events_event_name_occurred_at_idx" ON "user_events"("event_name", "occurred_at");

-- CreateIndex
CREATE INDEX "user_events_customer_id_occurred_at_idx" ON "user_events"("customer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "user_events_session_id_idx" ON "user_events"("session_id");

-- CreateIndex
CREATE INDEX "integration_events_status_received_at_idx" ON "integration_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_events_provider_external_event_id_key" ON "integration_events"("provider", "external_event_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_occurred_at_idx" ON "audit_log"("entity_type", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_user_id_occurred_at_idx" ON "audit_log"("actor_user_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_hours" ADD CONSTRAINT "store_hours_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_closures" ADD CONSTRAINT "store_closures_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_address_id_fkey" FOREIGN KEY ("shipping_address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_store_order_id_fkey" FOREIGN KEY ("store_order_id") REFERENCES "store_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_declarations" ADD CONSTRAINT "stock_declarations_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_declarations" ADD CONSTRAINT "stock_declarations_declared_by_id_fkey" FOREIGN KEY ("declared_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_store_order_id_fkey" FOREIGN KEY ("store_order_id") REFERENCES "store_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_store_order_id_fkey" FOREIGN KEY ("store_order_id") REFERENCES "store_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_source_store_order_id_fkey" FOREIGN KEY ("source_store_order_id") REFERENCES "store_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_strike_id_fkey" FOREIGN KEY ("strike_id") REFERENCES "strikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_marked_by_id_fkey" FOREIGN KEY ("marked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_settlements" ADD CONSTRAINT "pending_settlements_store_order_id_fkey" FOREIGN KEY ("store_order_id") REFERENCES "store_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_settlements" ADD CONSTRAINT "pending_settlements_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_store_order_id_fkey" FOREIGN KEY ("store_order_id") REFERENCES "store_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Domain invariants
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_quantity_nonnegative" CHECK ("quantity" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_prices_valid" CHECK (
    "unit_price_in_cents" >= 0
    AND ("wholesale_price_in_cents" IS NULL OR "wholesale_price_in_cents" >= 0)
    AND ("wholesale_minimum" IS NULL OR "wholesale_minimum" > 0)
);
ALTER TABLE "store_hours" ADD CONSTRAINT "store_hours_day_valid" CHECK ("day_of_week" BETWEEN 0 AND 6);
ALTER TABLE "store_hours" ADD CONSTRAINT "store_hours_range_valid" CHECK ("opens_at" < "closes_at");
ALTER TABLE "store_closures" ADD CONSTRAINT "store_closures_range_valid" CHECK ("starts_at" < "ends_at");
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_valid" CHECK (
    "subtotal_in_cents" >= 0
    AND "shipping_in_cents" >= 0
    AND "discount_in_cents" >= 0
    AND "total_in_cents" = "subtotal_in_cents" + "shipping_in_cents" - "discount_in_cents"
);
ALTER TABLE "orders" ADD CONSTRAINT "orders_promise_range_valid" CHECK (
    "promised_delivery_start_at" IS NULL
    OR "promised_delivery_end_at" IS NULL
    OR "promised_delivery_start_at" <= "promised_delivery_end_at"
);
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_amounts_valid" CHECK (
    "subtotal_in_cents" >= 0
    AND ("commission_rate_basis_points" IS NULL OR "commission_rate_basis_points" BETWEEN 0 AND 10000)
    AND ("commission_in_cents" IS NULL OR "commission_in_cents" >= 0)
    AND ("net_amount_in_cents" IS NULL OR "net_amount_in_cents" >= 0)
);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_amounts_valid" CHECK (
    "quantity" > 0
    AND "unit_price_in_cents" >= 0
    AND "total_in_cents" = "unit_price_in_cents" * "quantity"
);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_valid" CHECK (
    "quantity" <> 0 AND "balance_after" >= 0
);
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_quantity_valid" CHECK ("quantity" > 0);
ALTER TABLE "stock_holds" ADD CONSTRAINT "stock_holds_expiration_valid" CHECK (
    "status" <> 'LIVE' OR "expires_at" IS NOT NULL
);
ALTER TABLE "stock_declarations" ADD CONSTRAINT "stock_declarations_values_valid" CHECK (
    "declared_quantity" >= 0
    AND "overnight_limit" >= 0
    AND "overnight_limit" <= "declared_quantity"
    AND "declared_at" < "expires_at"
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_nonnegative" CHECK ("amount_in_cents" >= 0);
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_rate_nonnegative" CHECK ("shipping_rate_in_cents" >= 0);
ALTER TABLE "strikes" ADD CONSTRAINT "strikes_expiration_valid" CHECK ("occurred_at" < "expires_at");
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_nonnegative" CHECK ("amount_in_cents" >= 0);
ALTER TABLE "pending_settlements" ADD CONSTRAINT "pending_settlements_amounts_nonnegative" CHECK (
    "gross_amount_in_cents" >= 0
    AND "commission_in_cents" >= 0
    AND "net_amount_in_cents" >= 0
);
ALTER TABLE "compensations" ADD CONSTRAINT "compensations_amount_nonnegative" CHECK (
    "amount_in_cents" IS NULL OR "amount_in_cents" >= 0
);
ALTER TABLE "customer_credits" ADD CONSTRAINT "customer_credits_balance_nonnegative" CHECK ("balance_after" >= 0);
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_values_valid" CHECK (
    "min_items" > 0
    AND ("max_items" IS NULL OR "max_items" >= "min_items")
    AND "rate_in_cents" >= 0
    AND ("effective_to" IS NULL OR "effective_from" < "effective_to")
);
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_attempts_nonnegative" CHECK ("attempts" >= 0);

CREATE UNIQUE INDEX "addresses_one_active_default_per_customer"
ON "addresses" ("customer_id")
WHERE "is_default" = true AND "deleted_at" IS NULL;

-- Historical and financial records are append-only by contract.
CREATE FUNCTION reject_append_only_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_append_only"
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER "ledger_entries_append_only"
BEFORE UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER "customer_credits_append_only"
BEFORE UPDATE OR DELETE ON "customer_credits"
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER "stock_movements_append_only"
BEFORE UPDATE OR DELETE ON "stock_movements"
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

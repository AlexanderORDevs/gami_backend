CREATE TABLE "onboarding_batches" (
    "id" UUID NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "source" VARCHAR(120) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "report" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "onboarding_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onboarding_batches_content_hash_key" ON "onboarding_batches"("content_hash");
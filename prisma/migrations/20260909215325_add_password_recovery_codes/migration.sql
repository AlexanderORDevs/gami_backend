-- CreateTable
CREATE TABLE "password_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_recovery_codes_code_hash_key" ON "password_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "password_recovery_codes_user_id_used_at_expires_at_idx" ON "password_recovery_codes"("user_id", "used_at", "expires_at");

-- AddForeignKey
ALTER TABLE "password_recovery_codes" ADD CONSTRAINT "password_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

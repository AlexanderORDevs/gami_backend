-- CreateEnum
CREATE TYPE "RecoveryCodePurpose" AS ENUM ('BACKUP', 'EMAIL_RESET');

-- AlterTable
ALTER TABLE "password_recovery_codes" ADD COLUMN     "purpose" "RecoveryCodePurpose" NOT NULL DEFAULT 'BACKUP';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "resetAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resetCode" TEXT,
ADD COLUMN     "resetCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "resetWindowStart" TIMESTAMP(3);

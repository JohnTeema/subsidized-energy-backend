-- AddSrePointsToUser
ALTER TABLE "User" ADD COLUMN "srePoints" Float NOT NULL DEFAULT 0;

-- CreateSrePointsLog
CREATE TABLE "SrePointsLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" Float NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
    CONSTRAINT "SrePointsLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SrePointsLog" ADD CONSTRAINT "SrePointsLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "SrePointsLog_userId_idx" ON "SrePointsLog"("userId");

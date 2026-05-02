-- CreateTable
CREATE TABLE "EsgBuyer" (
    "id" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "annualTarget" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EsgBuyer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EsgBuyer_walletAddress_key" ON "EsgBuyer"("walletAddress");

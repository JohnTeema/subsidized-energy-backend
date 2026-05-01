-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InverterConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inverterId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL DEFAULT '',
    "credentials" TEXT NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InverterConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnergyReading" (
    "id" TEXT NOT NULL,
    "inverterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kwhProduced" DOUBLE PRECISION NOT NULL,
    "intervalStart" TIMESTAMP(3) NOT NULL,
    "intervalEnd" TIMESTAMP(3) NOT NULL,
    "rawDataHash" TEXT NOT NULL,
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "validationError" TEXT,
    "txHash" TEXT,
    "onChainRecordId" INTEGER,
    "subMinted" DOUBLE PRECISION,
    "sreMinted" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnergyReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "InverterConnection_inverterId_key" ON "InverterConnection"("inverterId");

-- AddForeignKey
ALTER TABLE "InverterConnection" ADD CONSTRAINT "InverterConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnergyReading" ADD CONSTRAINT "EnergyReading_inverterId_fkey" FOREIGN KEY ("inverterId") REFERENCES "InverterConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnergyReading" ADD CONSTRAINT "EnergyReading_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: InverterConnection — add device metadata columns
ALTER TABLE "InverterConnection"
  ADD COLUMN IF NOT EXISTS "deviceSerial" TEXT,
  ADD COLUMN IF NOT EXISTS "plantName"    TEXT,
  ADD COLUMN IF NOT EXISTS "location"     TEXT;

-- AlterTable: EnergyReading — add inverter telemetry columns
ALTER TABLE "EnergyReading"
  ADD COLUMN IF NOT EXISTS "panelPower"      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "batteryCapacity" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "batteryVoltage"  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "epvTotal"        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "epvToday"        DOUBLE PRECISION;

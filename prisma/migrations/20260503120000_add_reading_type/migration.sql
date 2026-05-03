-- Add readingType column to distinguish cumulative intraday snapshots from daily totals
ALTER TABLE "EnergyReading" ADD COLUMN "readingType" TEXT NOT NULL DEFAULT 'snapshot';

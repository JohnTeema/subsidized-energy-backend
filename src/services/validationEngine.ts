import prisma from '../db/client';
import { SimulatedReading } from './mockSimulator';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const MAX_CAPACITY_KWH_PER_15MIN = 25 * 0.25; // 25 kW system max → 6.25 kWh per 15 min
const MIN_INTERVAL_MS = 10 * 60 * 1000;         // at least 10 minutes
const MAX_INTERVAL_MS = 20 * 60 * 1000;         // at most 20 minutes
const MAX_FUTURE_TOLERANCE_MS = 60 * 1000;      // 1 minute grace period

export async function validateReading(
  reading: SimulatedReading,
  inverterId: string,
): Promise<ValidationResult> {
  const now = new Date();

  // 1. Timestamp check — interval must not be in the future
  if (reading.intervalEnd.getTime() > now.getTime() + MAX_FUTURE_TOLERANCE_MS) {
    return { valid: false, error: 'Interval end is in the future' };
  }
  if (reading.intervalStart.getTime() > reading.intervalEnd.getTime()) {
    return { valid: false, error: 'Interval start is after interval end' };
  }

  // 2. Interval length check — must be ~15 minutes
  const durationMs = reading.intervalEnd.getTime() - reading.intervalStart.getTime();
  if (durationMs < MIN_INTERVAL_MS || durationMs > MAX_INTERVAL_MS) {
    return { valid: false, error: `Interval duration ${Math.round(durationMs / 60000)}m is outside expected 10–20 min range` };
  }

  // 3. Duplicate check — no existing reading for this inverter covering the same interval
  const duplicate = await prisma.energyReading.findFirst({
    where: {
      inverterId,
      intervalStart: reading.intervalStart,
      intervalEnd: reading.intervalEnd,
    },
  });
  if (duplicate) {
    return { valid: false, error: 'Duplicate reading for this interval already exists' };
  }

  // 4. Capacity check — kWh must not exceed system maximum
  if (reading.kwhProduced > MAX_CAPACITY_KWH_PER_15MIN) {
    return { valid: false, error: `kWh ${reading.kwhProduced} exceeds max capacity ${MAX_CAPACITY_KWH_PER_15MIN}` };
  }

  // 5. Non-negative check — production cannot be negative or zero
  if (reading.kwhProduced <= 0) {
    return { valid: false, error: 'kWh produced must be greater than zero' };
  }

  return { valid: true };
}

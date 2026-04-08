/**
 * Mock Solar Inverter Simulator
 *
 * Generates realistic solar production data based on time of day.
 * Uses a Gaussian curve centered at solar noon (12:00) with ~4h std dev.
 * Peak output: ~5 kW (typical residential system).
 * Zero output during night hours (before 6am / after 8pm).
 */

export interface SimulatedReading {
  inverterId: string;
  kwhProduced: number;   // kWh over the 15-minute interval
  intervalStart: Date;
  intervalEnd: Date;
  rawData: Record<string, unknown>;
}

function solarPowerKw(date: Date): number {
  const hours = date.getHours() + date.getMinutes() / 60;

  // Night → zero production
  if (hours < 6 || hours > 20) return 0;

  // Gaussian bell curve peaking at noon
  const peakHour = 12;
  const sigma = 3.5; // std dev in hours
  const peakKw = 5.2; // peak system output in kW
  const gaussian = Math.exp(-Math.pow(hours - peakHour, 2) / (2 * sigma * sigma));

  // Add small random noise ±5%
  const noise = 1 + (Math.random() - 0.5) * 0.1;
  return peakKw * gaussian * noise;
}

export function generateReading(inverterId: string, atTime?: Date): SimulatedReading {
  const intervalEnd = atTime ?? new Date();
  const intervalStart = new Date(intervalEnd.getTime() - 15 * 60 * 1000); // 15 minutes prior

  // Average power over the interval (use midpoint approximation)
  const midpoint = new Date((intervalStart.getTime() + intervalEnd.getTime()) / 2);
  const avgPowerKw = solarPowerKw(midpoint);

  // kWh = kW × hours; 15 min = 0.25 hr
  const kwhProduced = Math.max(0, avgPowerKw * 0.25);

  const rawData = {
    inverterId,
    timestamp: intervalEnd.toISOString(),
    powerW: Math.round(avgPowerKw * 1000),
    energyWh: Math.round(kwhProduced * 1000),
    voltage: 240 + Math.random() * 4 - 2,
    frequency: 60 + Math.random() * 0.1 - 0.05,
    temperature: 25 + Math.random() * 10,
  };

  return {
    inverterId,
    kwhProduced: parseFloat(kwhProduced.toFixed(4)),
    intervalStart,
    intervalEnd,
    rawData,
  };
}

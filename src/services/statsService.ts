import prisma from '../db/client';

/**
 * Platform-wide total kWh: sum of daily max(kwhProduced) per inverter per day.
 * Canonical source of truth for all kWh statistics.
 */
export async function getTotalKwhProduced(): Promise<number> {
  try {
    const result = await prisma.$queryRaw<[{ total: number }]>`
      SELECT COALESCE(SUM(daily_max), 0)::float AS total
      FROM (
        SELECT DATE_TRUNC('day', "intervalStart") AS day,
               "inverterId",
               MAX("kwhProduced") AS daily_max
        FROM "EnergyReading"
        WHERE "readingType" = 'snapshot' AND "validated" = true
        GROUP BY DATE_TRUNC('day', "intervalStart"), "inverterId"
      ) t
    `;
    const total = parseFloat((result[0]?.total ?? 0).toFixed(4));
    console.log('[stats] totalKwh calculated:', total);
    return total;
  } catch (err) {
    console.error('[stats] Error calculating totalKwh:', err);
    return 0;
  }
}

/**
 * Per-user total kWh: sum of daily max(kwhProduced) for this user's inverters.
 */
export async function getUserTotalKwhProduced(userId: string): Promise<number> {
  try {
    const result = await prisma.$queryRaw<[{ total: number }]>`
      SELECT COALESCE(SUM(daily_max), 0)::float AS total
      FROM (
        SELECT DATE_TRUNC('day', "intervalStart") AS day,
               MAX("kwhProduced") AS daily_max
        FROM "EnergyReading"
        WHERE "readingType" = 'snapshot'
          AND "validated" = true
          AND "userId" = ${userId}
        GROUP BY DATE_TRUNC('day', "intervalStart")
      ) t
    `;
    return parseFloat((result[0]?.total ?? 0).toFixed(4));
  } catch (err) {
    console.error('[stats] Error calculating user totalKwh:', err);
    return 0;
  }
}

/**
 * Per-user daily readings for chart: last N days of daily max(kwhProduced).
 */
export async function getUserDailyReadings(userId: string, days: number = 30): Promise<{ time: string; kwh: number }[]> {
  try {
    const raw = await prisma.$queryRaw<
      { day: string; daily_max: number }[]
    >`
      SELECT DATE_TRUNC('day', "intervalStart") AS day,
             MAX("kwhProduced") AS daily_max
      FROM "EnergyReading"
      WHERE "readingType" = 'snapshot'
        AND "validated" = true
        AND "userId" = ${userId}
        AND "intervalStart" >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE_TRUNC('day', "intervalStart")
      ORDER BY day ASC
    `;
    return raw.map((r) => ({
      time: new Date(r.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      kwh: parseFloat(r.daily_max.toFixed(4)),
    }));
  } catch (err) {
    console.error('[stats] Error calculating user daily readings:', err);
    return [];
  }
}

/**
 * Latest reading (most recent snapshot) for a user, including panel power.
 */
export async function getLatestReadingForUser(userId: string) {
  try {
    const reading = await prisma.energyReading.findFirst({
      where: { userId, readingType: 'snapshot' },
      orderBy: { intervalStart: 'desc' },
      select: {
        kwhProduced: true,
        panelPower: true,
        intervalStart: true,
      },
    });
    return reading;
  } catch (err) {
    console.error('[stats] Error fetching latest reading:', err);
    return null;
  }
}

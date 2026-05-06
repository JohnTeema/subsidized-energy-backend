import prisma from '../db/client';

/**
 * Platform-wide total kWh: sum of daily production per inverter per day.
 * Canonical source of truth for all kWh statistics.
 */
export async function getTotalKwhProduced(): Promise<number> {
  try {
    const result = await prisma.$queryRaw<[{ total: number }]>`
      SELECT COALESCE(SUM(daily_kwh), 0)::float AS total
      FROM (
        SELECT DATE_TRUNC('day', er."intervalStart") AS day,
               er."inverterId",
               CASE
                 WHEN MAX(ic."brand") = 'growatt'
                   THEN COALESCE(MAX(er."epvToday"), MAX(er."kwhProduced"), 0)
                 ELSE SUM(er."kwhProduced")
               END AS daily_kwh
        FROM "EnergyReading" er
        JOIN "InverterConnection" ic ON ic."id" = er."inverterId"
        WHERE er."readingType" = 'snapshot' AND er."validated" = true
        GROUP BY DATE_TRUNC('day', er."intervalStart"), er."inverterId"
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
 * Per-user total kWh: sum of daily production for this user's inverters.
 */
export async function getUserTotalKwhProduced(userId: string): Promise<number> {
  try {
    const result = await prisma.$queryRaw<[{ total: number }]>`
      SELECT COALESCE(SUM(daily_kwh), 0)::float AS total
      FROM (
        SELECT DATE_TRUNC('day', er."intervalStart") AS day,
               er."inverterId",
               CASE
                 WHEN MAX(ic."brand") = 'growatt'
                   THEN COALESCE(MAX(er."epvToday"), MAX(er."kwhProduced"), 0)
                 ELSE SUM(er."kwhProduced")
               END AS daily_kwh
        FROM "EnergyReading" er
        JOIN "InverterConnection" ic ON ic."id" = er."inverterId"
        WHERE er."readingType" = 'snapshot'
          AND er."validated" = true
          AND er."userId" = ${userId}
        GROUP BY DATE_TRUNC('day', er."intervalStart"), er."inverterId"
      ) t
    `;
    return parseFloat((result[0]?.total ?? 0).toFixed(4));
  } catch (err) {
    console.error('[stats] Error calculating user totalKwh:', err);
    return 0;
  }
}

/**
 * Per-user daily readings for chart: last N days of daily production.
 */
export async function getUserDailyReadings(userId: string, days: number = 30): Promise<{ time: string; kwh: number }[]> {
  try {
    const raw = await prisma.$queryRaw<
      { day: string; daily_kwh: number }[]
    >`
      SELECT day, COALESCE(SUM(inverter_daily_kwh), 0)::float AS daily_kwh
      FROM (
        SELECT DATE_TRUNC('day', er."intervalStart") AS day,
               er."inverterId",
               CASE
                 WHEN MAX(ic."brand") = 'growatt'
                   THEN COALESCE(MAX(er."epvToday"), MAX(er."kwhProduced"), 0)
                 ELSE SUM(er."kwhProduced")
               END AS inverter_daily_kwh
        FROM "EnergyReading" er
        JOIN "InverterConnection" ic ON ic."id" = er."inverterId"
        WHERE er."readingType" = 'snapshot'
          AND er."validated" = true
          AND er."userId" = ${userId}
          AND er."intervalStart" >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE_TRUNC('day', er."intervalStart"), er."inverterId"
      ) t
      GROUP BY day
      ORDER BY day ASC
    `;
    return raw.map((r) => ({
      time: new Date(r.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      kwh: parseFloat(r.daily_kwh.toFixed(4)),
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

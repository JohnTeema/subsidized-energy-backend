import { Router, Response } from 'express';
import prisma from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

/**
 * GET /api/user/dashboard
 * Returns authenticated user's dashboard data including:
 * - srePoints: current SRE points balance
 * - totalKwhProduced: maximum daily kWh produced (sum of daily_max readings)
 * - subCertificates: count of daily_total readings
 * - latestReading: most recent snapshot with kWh, panelPower (rawData fields), timestamp
 * - dailyReadings: today's snapshots for chart (date, cumulative kWh)
 * - environmentalImpact: co2Avoided, treesEquivalent, drivingOffset, homesPowered
 */
router.get('/dashboard', requireAuth, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = _req.userId!;

    // Fetch user with srePoints
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { srePoints: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Total kWh produced: sum of all daily_total reading values
    const totalKwhResult = await prisma.energyReading.aggregate({
      where: { userId, readingType: 'daily_total' },
      _sum: { kwhProduced: true },
    });
    const totalKwhProduced = totalKwhResult._sum.kwhProduced ?? 0;

    // Sub certificates: count of daily_total readings
    const subCertificates = await prisma.energyReading.count({
      where: { userId, readingType: 'daily_total' },
    });

    // Latest reading (most recent snapshot, not daily_total)
    const latestReading = await prisma.energyReading.findFirst({
      where: { userId, readingType: 'snapshot' },
      orderBy: { createdAt: 'desc' },
      select: {
        kwhProduced: true,
        rawData: true,
        intervalStart: true,
        createdAt: true,
      },
    });

    // Today's snapshots for chart (cumulative kWh by time)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todaySnapshots = await prisma.energyReading.findMany({
      where: {
        userId,
        readingType: 'snapshot',
        intervalStart: { gte: todayStart },
      },
      orderBy: { intervalStart: 'asc' },
      select: {
        intervalStart: true,
        kwhProduced: true,
      },
    });

    const dailyReadings = todaySnapshots.map(s => ({
      time: s.intervalStart.toISOString().substring(11, 16), // HH:MM
      kwh: s.kwhProduced,
    }));

    // Environmental impact calculations (using standard conversion factors)
    const co2Avoided = totalKwhProduced * 0.5; // kg CO2 (0.5 kg/kWh grid average)
    const treesEquivalent = co2Avoided / 20; // 1 tree absorbs ~20 kg CO2/year
    const drivingOffset = co2Avoided / 0.2; // km (avg car: 0.2 kg CO2/km)
    const homesPowered = totalKwhProduced / 30; // avg home uses ~30 kWh/day equivalent

    res.json({
      srePoints: user.srePoints,
      totalKwhProduced: Math.round(totalKwhProduced * 100) / 100,
      subCertificates,
      latestReading: latestReading
        ? {
            kWh: latestReading.kwhProduced,
            panelPower: (latestReading.rawData as any)?.ac_power ?? null,
            timestamp: latestReading.createdAt,
          }
        : null,
      dailyReadings,
      environmentalImpact: {
        co2Avoided: Math.round(co2Avoided * 100) / 100,
        treesEquivalent: Math.round(treesEquivalent * 100) / 100,
        drivingOffset: Math.round(drivingOffset * 100) / 100,
        homesPowered: Math.round(homesPowered * 100) / 100,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[user/dashboard]', msg);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

/**
 * GET /api/user/sre-points-history
 * Returns SRE points log entries for the authenticated user.
 */
router.get('/sre-points-history', requireAuth, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = _req.userId!;
    const limit = parseInt(_req.query.limit as string) || 50;

    const history = await prisma.srePointsLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      select: {
        id: true,
        amount: true,
        reason: true,
        createdAt: true,
        meta: true,
      },
    });

    res.json({ history });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[user/sre-points-history]', msg);
    res.status(500).json({ error: 'Failed to fetch SRE points history' });
  }
});

export default router;

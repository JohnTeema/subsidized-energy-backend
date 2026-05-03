import { Router, Response } from 'express';
import prisma from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getUserTotalKwhProduced, getUserDailyReadings, getLatestReadingForUser } from '../services/statsService';

const router = Router();

router.get('/dashboard', requireAuth, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = _req.userId!;

    // Parallel fetches
    const [user, subCertificatesCount, totalKwhProduced, dailyReadings, latestReading] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { srePoints: true },
      }),
      prisma.energyReading.count({
        where: { userId, readingType: 'daily_total' },
      }),
      getUserTotalKwhProduced(userId),
      getUserDailyReadings(userId, 30),
      getLatestReadingForUser(userId),
    ]);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const srePoints = user.srePoints ?? 0;

    // Compute environmental impact from personal totalKwhProduced
    const co2AvoidedKg = totalKwhProduced * 0.43;
    const environmentalImpact = {
      co2Avoided: parseFloat(co2AvoidedKg.toFixed(2)),           // kg
      treesEquivalent: parseFloat((co2AvoidedKg / 21).toFixed(2)), // trees
      drivingOffset: parseFloat((co2AvoidedKg / 0.21).toFixed(2)), // km
      homesPowered: parseFloat((totalKwhProduced / 900).toFixed(2)), // homes
    };

    res.json({
      srePoints,
      totalKwhProduced,
      subCertificates: subCertificatesCount,
      latestReading: latestReading
        ? {
            kWh: parseFloat(latestReading.kwhProduced.toFixed(4)),
            panelPower: latestReading.panelPower ? Math.round(latestReading.panelPower) : null,
            timestamp: latestReading.intervalStart.toISOString(),
          }
        : null,
      dailyReadings,
      environmentalImpact,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[user/dashboard]', msg);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

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

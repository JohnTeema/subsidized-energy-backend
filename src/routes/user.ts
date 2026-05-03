import { Router, Response } from 'express';
import prisma from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

router.get('/dashboard', requireAuth, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = _req.userId!;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { srePoints: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const inverter = await prisma.inverterConnection.findFirst({
      where: { userId, isActive: true },
    });

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // All of today's snapshots, oldest → newest
    const todaySnapshots = inverter
      ? await prisma.energyReading.findMany({
          where: {
            userId,
            inverterId: inverter.id,
            readingType: 'snapshot',
            intervalStart: { gte: todayStart },
          },
          orderBy: { intervalStart: 'asc' },
          select: {
            intervalStart: true,
            kwhProduced: true,
            panelPower: true,
            batteryCapacity: true,
            batteryVoltage: true,
            epvTotal: true,
            epvToday: true,
          },
        })
      : [];

    // Latest snapshot carries the current real-time values
    const latest = todaySnapshots.length > 0 ? todaySnapshots[todaySnapshots.length - 1] : null;

    const todayKwh = latest?.epvToday ?? 0;
    const lifetimeKwh = latest?.epvTotal ?? 0;
    const currentPanelPower = latest?.panelPower ?? 0;
    const batteryCapacity = latest?.batteryCapacity ?? 0;
    const batteryVoltage = latest?.batteryVoltage ?? 0;

    const subCertificates = await prisma.energyReading.count({
      where: { userId, readingType: 'daily_total' },
    });

    const co2AvoidedKg = todayKwh * 0.43;

    res.json({
      srePoints: user.srePoints,
      todayKwh: Math.round(todayKwh * 100) / 100,
      lifetimeKwh: Math.round(lifetimeKwh * 100) / 100,
      currentPanelPower: Math.round(currentPanelPower),
      batteryCapacity: Math.round(batteryCapacity * 10) / 10,
      batteryVoltage: Math.round(batteryVoltage * 10) / 10,
      subCertificates,
      connectedInverter: inverter
        ? {
            brand: inverter.brand,
            deviceId: inverter.deviceSerial ?? inverter.inverterId,
            plantName: inverter.plantName ?? null,
            location: inverter.location ?? null,
            isActive: inverter.isActive,
          }
        : null,
      todaySnapshots: todaySnapshots.map(s => ({
        time: s.intervalStart.toISOString().substring(11, 16), // HH:MM
        kwh: Math.round((s.epvToday ?? s.kwhProduced) * 100) / 100,
      })),
      environmentalImpact: {
        co2AvoidedKg: Math.round(co2AvoidedKg * 100) / 100,
        treesEquivalent: Math.round((co2AvoidedKg / 21) * 1000) / 1000,
        drivingOffsetKm: Math.round((co2AvoidedKg / 0.21) * 10) / 10,
        homesPowered: Math.round((todayKwh / 900) * 10000) / 10000,
      },
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

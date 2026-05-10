import { Router, Request, Response } from 'express';
import prisma from '../db/client';
import { getTotalKwhProduced } from '../services/statsService';
import { reinitNetworkState } from '../services/solanaBlockchainService';

const router = Router();

router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const weekAgoUtc = new Date(todayUtc.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalVerifiedUsers,
      totalInverterConnections,
      activeInverters,
      totalEnergyReadings,
      invertersByBrand,
      totalSrePointsDistributedRaw,
      subToday,
      subWeek,
      subAllTime,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { inverters: { some: { isActive: true } } } }),
      prisma.inverterConnection.count(),
      prisma.inverterConnection.count({ where: { isActive: true } }),
      prisma.energyReading.count(),
      prisma.inverterConnection.groupBy({ by: ['brand'], _count: { id: true } }),
      prisma.user.aggregate({ _sum: { srePoints: true } }),
      // SUB is only written on daily_total records (one per inverter per day)
      prisma.energyReading.aggregate({
        where: { readingType: 'daily_total', intervalStart: { gte: todayUtc } },
        _sum: { subMinted: true },
      }),
      prisma.energyReading.aggregate({
        where: { readingType: 'daily_total', intervalStart: { gte: weekAgoUtc } },
        _sum: { subMinted: true },
      }),
      prisma.energyReading.aggregate({
        where: { readingType: 'daily_total' },
        _sum: { subMinted: true },
      }),
    ]);

    const totalKwhProduced = await getTotalKwhProduced();
    const totalSrePointsDistributed = totalSrePointsDistributedRaw._sum?.srePoints ?? 0;
    const totalCarbonOffset = parseFloat((totalKwhProduced * 0.43).toFixed(2));

    res.json({
      totalUsers,
      totalVerifiedUsers,
      totalInverterConnections,
      activeInverters,
      totalEnergyReadings,
      totalKwhProduced,
      totalSrePointsDistributed,
      totalCarbonOffset,
      subMintedToday: subToday._sum.subMinted ?? 0,
      subMintedWeek: subWeek._sum.subMinted ?? 0,
      subMintedAllTime: subAllTime._sum.subMinted ?? 0,
      invertersByBrand: invertersByBrand.map((b) => ({ brand: b.brand, count: b._count.id })),
    });
  } catch (err) {
    console.error('[admin/stats] Error:', err);
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

router.get('/users', async (_req: Request, res: Response): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        walletAddress: true,
        emailVerified: true,
        createdAt: true,
        srePoints: true,
        inverters: {
          select: {
            id: true,
            inverterId: true,
            brand: true,
            isActive: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ users, total: users.length });
  } catch (err) {
    console.error('[admin/users] Error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/inverters', async (_req: Request, res: Response): Promise<void> => {
  try {
    const inverters = await prisma.inverterConnection.findMany({
      select: {
        id: true,
        inverterId: true,
        brand: true,
        isActive: true,
        createdAt: true,
        user: {
          select: { email: true, id: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ inverters, total: inverters.length });
  } catch (err) {
    console.error('[admin/inverters] Error:', err);
    res.status(500).json({ error: 'Failed to fetch inverters' });
  }
});

router.get('/energy', async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const [readingsRaw, total] = await Promise.all([
      prisma.energyReading.findMany({
        skip,
        take: limit,
        select: {
          id: true,
          kwhProduced: true,
          readingType: true,
          intervalStart: true,
          intervalEnd: true,
          validated: true,
          validationError: true,
          subMinted: true,
          createdAt: true,
          inverter: { select: { inverterId: true, brand: true } },
          user: { select: { email: true, walletAddress: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.energyReading.count(),
    ]);

    // Map to frontend EnergyReading shape
    const readings = readingsRaw.map((r) => {
      let status: 'verified' | 'flagged' | 'pending';
      if (r.validated) {
        status = 'verified';
      } else if (r.validationError && r.validationError.length > 0) {
        status = 'flagged';
      } else {
        status = 'pending';
      }

      const co2Offset = r.kwhProduced * 0.5;
      const date = new Date(r.intervalStart).toISOString().split('T')[0];

      return {
        id: r.id,
        producer: r.user.email,
        producerWallet: r.user.walletAddress,
        date,
        kWh: r.kwhProduced,
        deltaKwh: r.readingType === 'snapshot' ? r.kwhProduced : null,
        readingType: r.readingType,
        co2Offset,
        subMinted: r.subMinted ?? 0,
        status,
        inverterBrand: r.inverter.brand,
      };
    });

    res.json({
      readings,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[admin/energy] Error:', err);
    res.status(500).json({ error: 'Failed to fetch energy readings' });
  }
});

router.get('/esg-buyers', async (_req: Request, res: Response): Promise<void> => {
  try {
    const buyers = await prisma.esgBuyer.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json({ buyers, total: buyers.length });
  } catch (err) {
    console.error('[admin/esg-buyers] Error:', err);
    res.status(500).json({ error: 'Failed to fetch ESG buyers' });
  }
});

/**
 * POST /api/admin/reinit-network-state
 * Resizes and rewrites the NetworkState PDA when it was deployed with an older
 * (smaller) struct. Reads sre_mint/treasury/ecosystem from the live account;
 * accepts optional team and marketplaceProgram in the request body.
 */
router.post('/reinit-network-state', async (req: Request, res: Response): Promise<void> => {
  try {
    const { team, marketplaceProgram } = req.body as {
      team?: string;
      marketplaceProgram?: string;
    };
    console.log('[admin] reinit-network-state requested', { team, marketplaceProgram });
    const result = await reinitNetworkState({ team, marketplaceProgram });
    res.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[admin] reinit-network-state failed:', message);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

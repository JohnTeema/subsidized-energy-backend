import { Router, Request, Response } from 'express';
import prisma from '../db/client';

const router = Router();

router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [
      totalUsers,
      totalVerifiedUsers,
      totalInverterConnections,
      activeInverters,
      totalEnergyReadings,
      totalKwhResult,
      invertersByBrand,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { emailVerified: true } }),
      prisma.inverterConnection.count(),
      prisma.inverterConnection.count({ where: { isActive: true } }),
      prisma.energyReading.count(),
      prisma.energyReading.aggregate({ _sum: { kwhProduced: true } }),
      prisma.inverterConnection.groupBy({ by: ['brand'], _count: { id: true } }),
    ]);

    res.json({
      totalUsers,
      totalVerifiedUsers,
      totalInverterConnections,
      activeInverters,
      totalEnergyReadings,
      totalKwhProduced: parseFloat((totalKwhResult._sum.kwhProduced ?? 0).toFixed(4)),
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
      // Derive status from validated + validationError
      let status: 'verified' | 'flagged' | 'pending';
      if (r.validated) {
        status = 'verified';
      } else if (r.validationError && r.validationError.length > 0) {
        status = 'flagged';
      } else {
        status = 'pending';
      }

      // Derive CO2 offset — temporary factor (0.5 kg/kWh) until per-plant factor is stored
      const co2Offset = r.kwhProduced * 0.5;

      // Format date as YYYY-MM-DD for date filter compatibility
      const date = new Date(r.intervalStart).toISOString().split('T')[0];

      return {
        id: r.id,
        producer: r.user.email,
        producerWallet: r.user.walletAddress,
        date,
        kWh: r.kwhProduced,
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

export default router;

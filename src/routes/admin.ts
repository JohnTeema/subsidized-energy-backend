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
      invertersByBrand,
      kwhRows,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { inverters: { some: { isActive: true } } } }),
      prisma.inverterConnection.count(),
      prisma.inverterConnection.count({ where: { isActive: true } }),
      prisma.energyReading.count(),
      prisma.inverterConnection.groupBy({ by: ['brand'], _count: { id: true } }),
      // SUM of MAX(kwhProduced) per inverter per day — epvToday is cumulative so
      // the highest snapshot value for a given day is the real production total
      prisma.$queryRaw<[{ total: number }]>`
        SELECT COALESCE(SUM(daily_max), 0)::float AS total
        FROM (
          SELECT DATE_TRUNC('day', "intervalStart") AS day,
                 "inverterId",
                 MAX("kwhProduced") AS daily_max
          FROM "EnergyReading"
          WHERE "readingType" = 'snapshot' AND "validated" = true
          GROUP BY DATE_TRUNC('day', "intervalStart"), "inverterId"
        ) t
      `,
    ]);

    const totalKwhProduced = parseFloat((kwhRows[0]?.total ?? 0).toFixed(4));
    const srePointsSum = (await prisma.user.aggregate({ _sum: { srePoints: true } })). _sum;
    const totalSrePointsDistributed = srePointsSum?.srePoints ?? 0;

    res.json({
      totalUsers,
      totalVerifiedUsers,
      totalInverterConnections,
      activeInverters,
      totalEnergyReadings,
      totalKwhProduced,
      totalSrePointsDistributed,
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

    // Compute delta per snapshot: difference from the previous snapshot for the
    // same inverter on the same day (sorted ascending by time). Snapshots store
    // cumulative epvToday, so the delta is the actual increase since last poll.
    const prevByInverterDay = new Map<string, number>();

    // Process in chronological order to compute deltas, then reverse for the response
    const chronological = [...readingsRaw].reverse();
    const deltaMap = new Map<string, number | null>();
    for (const r of chronological) {
      const day = new Date(r.intervalStart).toISOString().split('T')[0];
      const key = `${r.inverter.inverterId}::${day}`;
      if (r.readingType === 'snapshot') {
        const prev = prevByInverterDay.get(key);
        deltaMap.set(r.id, prev !== undefined ? parseFloat((r.kwhProduced - prev).toFixed(4)) : r.kwhProduced);
        prevByInverterDay.set(key, r.kwhProduced);
      } else {
        deltaMap.set(r.id, null);
      }
    }

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
        deltaKwh: deltaMap.get(r.id) ?? null,
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

export default router;

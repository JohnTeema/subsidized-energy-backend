import { Router, Request, Response } from 'express';
import prisma from '../db/client';

const router = Router();

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [activeProducersCount, kwhRows] = await Promise.all([
      prisma.user.count({ where: { inverters: { some: { isActive: true } } } }),
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

    const totalKwh = parseFloat((kwhRows[0]?.total ?? 0).toFixed(4));

    res.json({
      totalKwh,
      activeProducers: activeProducersCount,
      carbonOffset: parseFloat((totalKwh * 0.43).toFixed(2)),
    });
  } catch (err) {
    console.error('[stats] Error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;

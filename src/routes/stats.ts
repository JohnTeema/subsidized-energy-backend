import { Router, Request, Response } from 'express';
import prisma from '../db/client';
import { getTotalKwhProduced } from '../services/statsService';

const router = Router();

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [activeProducersCount, totalKwh] = await Promise.all([
      // Count users with at least one active inverter connection
      prisma.user.count({ where: { inverters: { some: { isActive: true } } } }),
      getTotalKwhProduced(),
    ]);

    const carbonOffset = parseFloat((totalKwh * 0.43).toFixed(2));

    res.json({
      totalKwh,
      activeProducers: activeProducersCount,
      carbonOffset,
    });
  } catch (err) {
    console.error('[stats] Error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;

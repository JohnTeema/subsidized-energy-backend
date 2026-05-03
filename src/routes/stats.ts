import { Router, Request, Response } from 'express';
import prisma from '../db/client';

const router = Router();

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [kwhResult, activeInvertersCount, subResult, sreResult] = await Promise.all([
      prisma.energyReading.aggregate({ _sum: { kwhProduced: true }, where: { validated: true } }),
      prisma.inverterConnection.count({ where: { isActive: true } }),
      prisma.energyReading.aggregate({ _sum: { subMinted: true } }),
      prisma.energyReading.aggregate({ _sum: { sreMinted: true } }),
    ]);

    const totalKwh = kwhResult._sum.kwhProduced ?? 0;

    res.json({
      totalKwhVerified: parseFloat(totalKwh.toFixed(4)),
      activeProducers: activeInvertersCount,
      totalSubMinted: parseFloat((subResult._sum.subMinted ?? 0).toFixed(4)),
      totalSreMinted: parseFloat((sreResult._sum.sreMinted ?? 0).toFixed(4)),
      co2OffsetKg: parseFloat((totalKwh * 0.43).toFixed(2)),
    });
  } catch (err) {
    console.error('[stats] Error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;

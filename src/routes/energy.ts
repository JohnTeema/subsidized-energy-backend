import { Router, Response } from 'express';
import prisma from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getBalances } from '../services/blockchainRouter';
import { getUserTotalKwhProduced } from '../services/statsService';

const router = Router();

router.get('/summary', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const chain = req.query.chain as string | undefined;

  const [totalKwh, totalReadings] = await Promise.all([
    getUserTotalKwhProduced(req.userId!),
    prisma.energyReading.count({
      where: { userId: req.userId!, readingType: 'snapshot', validated: true },
    }),
  ]);

  let balances: { base?: { sub: string; sre: string }; solana?: { sub: string; sre: string } } = {};
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (user) {
      balances = await getBalances(user.walletAddress, chain);
    }
  } catch (err) {
    console.error('[energy/summary] Could not fetch on-chain balances:', err);
  }

  res.json({
    totalKwhProduced: parseFloat(totalKwh.toFixed(4)),
    totalReadings,
    balances,
    // Flat fields for backwards compatibility (prefer Base, fallback to Solana)
    subBalance: balances.base?.sub ?? balances.solana?.sub ?? '0',
    sreBalance: balances.base?.sre ?? balances.solana?.sre ?? '0',
  });
});

router.get('/history', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 200);
  const offset = parseInt(req.query.offset as string || '0', 10);

  const [readings, total] = await Promise.all([
    prisma.energyReading.findMany({
      where: { userId: req.userId! },
      orderBy: { intervalEnd: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        kwhProduced: true,
        intervalStart: true,
        intervalEnd: true,
        validated: true,
        validationError: true,
        txHash: true,
        onChainRecordId: true,
        subMinted: true,
        sreMinted: true,
        createdAt: true,
      },
    }),
    prisma.energyReading.count({ where: { userId: req.userId! } }),
  ]);

  res.json({ readings, total, limit, offset });
});

router.get('/chart', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const period = ((req.query.period as string) || 'weekly') as 'daily' | 'weekly' | 'monthly';
  const now = new Date();

  let since: Date;
  let buckets: { label: string; kwh: number; tokens: number }[];

  if (period === 'daily') {
    since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    buckets = Array.from({ length: 24 }, (_, i) => ({
      label: `${i.toString().padStart(2, '0')}:00`,
      kwh: 0,
      tokens: 0,
    }));
  } else if (period === 'monthly') {
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    buckets = Array.from({ length: 30 }, (_, i) => ({ label: `${i + 1}`, kwh: 0, tokens: 0 }));
  } else {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    buckets = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(since.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
      return { label: dayNames[d.getDay()], kwh: 0, tokens: 0 };
    });
  }

  const readings = await prisma.energyReading.findMany({
    where: {
      userId: req.userId!,
      readingType: 'snapshot',
      validated: true,
      intervalEnd: { gte: since },
    },
    orderBy: { intervalEnd: 'asc' },
    select: { kwhProduced: true, intervalEnd: true, sreMinted: true },
  });

  const msSince = since.getTime();
  for (const r of readings) {
    const d = new Date(r.intervalEnd);
    let idx: number;
    if (period === 'daily') {
      idx = d.getHours();
    } else {
      const dayOffset = Math.floor((d.getTime() - msSince) / (24 * 60 * 60 * 1000));
      idx = Math.min(Math.max(dayOffset - (period === 'weekly' ? 0 : 0), 0), buckets.length - 1);
    }
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].kwh += r.kwhProduced;
      buckets[idx].tokens += r.sreMinted ?? 0;
    }
  }

  res.json({
    data: buckets.map((b) => ({
      label: b.label,
      kwh: parseFloat(b.kwh.toFixed(3)),
      tokens: parseFloat(b.tokens.toFixed(3)),
    })),
    period,
  });
});

export default router;

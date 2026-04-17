import { Router, Response } from 'express';
import prisma from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getBalances } from '../services/blockchainRouter';

const router = Router();

router.get('/summary', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const chain = req.query.chain as string | undefined;

  const readings = await prisma.energyReading.findMany({
    where: { userId: req.userId!, validated: true },
  });

  const totalKwh = readings.reduce((sum, r) => sum + r.kwhProduced, 0);
  const totalReadings = readings.length;

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

export default router;

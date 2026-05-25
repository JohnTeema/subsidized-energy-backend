import { Router, Request, Response } from 'express';
import { runSimulationCycle, runDailyRecording } from '../services/schedulerService';
import { getSolanaWalletAddress } from '../services/solanaBlockchainService';
import { config } from '../config/env';
import prisma from '../db/client';

const router = Router();

/**
 * POST /api/dev/simulate
 * Manually triggers one polling cycle: fetch → validate → save readings
 */
router.post('/simulate', async (_req: Request, res: Response): Promise<void> => {
  console.log('[dev] Manual simulation triggered');
  try {
    const results = await runSimulationCycle();
    res.json({ success: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/dev/record-daily
 * Manually triggers the daily on-chain recording (aggregate + mint $SUB).
 */
router.post('/record-daily', async (_req: Request, res: Response): Promise<void> => {
  console.log('[dev] Manual daily recording triggered');
  try {
    const results = await runDailyRecording();
    res.json({ success: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/dev/reset-daily-lock
 * Clears lastRecordedDate so daily recording can re-run. Dev/testing only.
 */
router.post('/reset-daily-lock', async (req: Request, res: Response): Promise<void> => {
  const { userId, inverterId, brand } = req.body as {
    userId?: string;
    inverterId?: string;
    brand?: string;
  };

  const where: Record<string, unknown> = {};
  if (userId) where['userId'] = userId;
  if (inverterId) where['inverterId'] = inverterId;
  if (brand) where['brand'] = brand;

  const { count } = await prisma.inverterConnection.updateMany({
    where,
    data: { lastRecordedDate: null },
  });

  const scope = Object.keys(where).length === 0
    ? 'all inverters'
    : Object.entries(where).map(([k, v]) => `${k}=${v}`).join(', ');

  console.log(`[dev] reset-daily-lock cleared ${count} inverter(s) (${scope})`);
  res.json({ success: true, resetCount: count, message: `Reset lastRecordedDate for ${count} inverter(s)` });
});

/**
 * GET /api/dev/solana-status
 * Reports whether the Solana blockchain service is initialized and ready.
 */
router.get('/solana-status', (_req: Request, res: Response): void => {
  const walletAddress = getSolanaWalletAddress();
  const initialized = walletAddress.length > 0;
  res.json({
    initialized,
    walletAddress: initialized ? walletAddress : null,
    activeChains: config.activeChains,
    solanaRpcUrl: config.solana.rpcUrl,
    privateKeySet: config.solana.privateKey.length > 0,
  });
});

/**
 * DELETE /api/dev/delete-user
 * Removes a user and all their related records by email. Dev/testing only.
 */
router.delete('/delete-user', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body as { email?: string };

  if (!email) {
    res.status(400).json({ success: false, error: 'email is required' });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Delete in FK-safe order: readings → sre logs → inverter connections → user
    await prisma.energyReading.deleteMany({ where: { userId: user.id } });
    await prisma.srePointsLog.deleteMany({ where: { userId: user.id } });
    await prisma.inverterConnection.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });

    console.log(`[dev] Deleted user ${email} (id=${user.id})`);
    res.json({ success: true, deleted: email });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;

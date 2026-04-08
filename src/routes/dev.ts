import { Router, Request, Response } from 'express';
import { runSimulationCycle } from '../services/schedulerService';

const router = Router();

/**
 * POST /api/dev/simulate
 * Manually triggers one full cycle: generate → validate → submit on-chain
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

export default router;

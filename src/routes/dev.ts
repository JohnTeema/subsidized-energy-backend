import { Router, Request, Response } from 'express';
import { runSimulationCycle, runDailyRecording } from '../services/schedulerService';

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

export default router;

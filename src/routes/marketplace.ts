import { Router, Request, Response } from 'express';

const router = Router();

// Marketplace listings live on-chain; this endpoint exists for future off-chain indexing.
// Returns an empty list until an indexer populates a Listing table.
router.get('/listings', (_req: Request, res: Response): void => {
  res.json({ listings: [], total: 0 });
});

export default router;

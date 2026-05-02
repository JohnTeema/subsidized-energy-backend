import { Router, Request, Response } from 'express';
import prisma from '../db/client';

const router = Router();

router.get('/listings', (_req: Request, res: Response): void => {
  res.json({ listings: [], total: 0 });
});

router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const totalBuyers = await prisma.esgBuyer.count();
    res.json({
      totalListings: 0,
      totalVolume: 0,
      totalBuyers,
      averagePrice: 0,
    });
  } catch (err) {
    console.error('[marketplace/stats] Error:', err);
    res.status(500).json({ error: 'Failed to fetch marketplace stats' });
  }
});

router.get('/check-buyer', async (req: Request, res: Response): Promise<void> => {
  const wallet = (req.query.wallet as string)?.trim();
  if (!wallet) {
    res.status(400).json({ error: 'wallet query param is required' });
    return;
  }
  try {
    const buyer = await prisma.esgBuyer.findUnique({
      where: { walletAddress: wallet },
      select: {
        id: true,
        organizationName: true,
        companyId: true,
        country: true,
        industry: true,
        contactEmail: true,
        walletAddress: true,
        annualTarget: true,
        createdAt: true,
      },
    });
    res.json({ registered: buyer !== null, buyer });
  } catch (err) {
    console.error('[marketplace/check-buyer] Error:', err);
    res.status(500).json({ error: 'Failed to check buyer registration' });
  }
});

router.post('/register-buyer', async (req: Request, res: Response): Promise<void> => {
  const { organizationName, companyId, country, industry, contactEmail, walletAddress, annualTarget } = req.body;

  if (!organizationName || !companyId || !country || !industry || !contactEmail || !walletAddress) {
    res.status(400).json({ error: 'organizationName, companyId, country, industry, contactEmail, and walletAddress are required' });
    return;
  }

  try {
    const existing = await prisma.esgBuyer.findUnique({ where: { walletAddress } });
    if (existing) {
      res.status(409).json({ error: 'Wallet address is already registered as an ESG buyer', buyer: existing });
      return;
    }

    const buyer = await prisma.esgBuyer.create({
      data: {
        organizationName,
        companyId,
        country,
        industry,
        contactEmail,
        walletAddress,
        annualTarget: annualTarget != null ? parseFloat(annualTarget) : null,
      },
    });

    res.status(201).json({ buyer });
  } catch (err) {
    console.error('[marketplace/register-buyer] Error:', err);
    res.status(500).json({ error: 'Failed to register ESG buyer' });
  }
});

export default router;

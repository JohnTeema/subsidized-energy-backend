import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

router.post('/connect', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { brand, apiKey } = req.body;

  if (!brand || !apiKey) {
    res.status(400).json({ error: 'brand and apiKey are required' });
    return;
  }

  // Generate a unique inverterId for this connection
  const inverterId = `${brand.toLowerCase().replace(/\s+/g, '-')}-${uuidv4().slice(0, 8)}`;

  const existing = await prisma.inverterConnection.findFirst({
    where: { userId: req.userId!, brand, apiKey },
  });
  if (existing) {
    res.status(409).json({ error: 'Inverter with this brand and API key already connected' });
    return;
  }

  const connection = await prisma.inverterConnection.create({
    data: {
      userId: req.userId!,
      inverterId,
      brand,
      apiKey,
      isActive: true,
    },
  });

  res.status(201).json({
    id: connection.id,
    inverterId: connection.inverterId,
    brand: connection.brand,
    isActive: connection.isActive,
    connectedAt: connection.createdAt,
  });
});

router.get('/status', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const connections = await prisma.inverterConnection.findMany({
    where: { userId: req.userId! },
    select: {
      id: true,
      inverterId: true,
      brand: true,
      isActive: true,
      createdAt: true,
    },
  });

  res.json({ inverters: connections });
});

export default router;

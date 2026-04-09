import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/client';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getAdapter, SUPPORTED_BRANDS, BRAND_CREDENTIAL_FIELDS } from '../adapters';
import { encryptCredentials } from '../utils/credentialsCrypto';

const router = Router();

router.post('/connect', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { brand, credentials } = req.body as {
    brand: string;
    credentials: Record<string, string>;
  };

  if (!brand) {
    res.status(400).json({ error: 'brand is required' });
    return;
  }
  if (!credentials || typeof credentials !== 'object') {
    res.status(400).json({ error: 'credentials object is required' });
    return;
  }

  // Validate brand
  if (!SUPPORTED_BRANDS.includes(brand as never)) {
    res.status(400).json({
      error: `Unsupported brand: "${brand}"`,
      supported: SUPPORTED_BRANDS,
    });
    return;
  }

  // Validate required credential fields
  const fields = BRAND_CREDENTIAL_FIELDS[brand as keyof typeof BRAND_CREDENTIAL_FIELDS] ?? [];
  const missing = fields.filter(f => !credentials[f.field]).map(f => f.field);
  if (missing.length > 0) {
    res.status(400).json({ error: `Missing required credentials: ${missing.join(', ')}` });
    return;
  }

  // Test connection before storing
  let testResult;
  try {
    const adapter = getAdapter(brand);
    testResult = await adapter.testConnection(credentials);
  } catch (err) {
    res.status(502).json({ error: `Connection test error: ${String(err)}` });
    return;
  }

  if (!testResult.success) {
    res.status(400).json({ error: `Connection test failed: ${testResult.message}` });
    return;
  }

  // Check for duplicate connection
  const existing = await prisma.inverterConnection.findFirst({
    where: { userId: req.userId!, brand },
  });
  if (existing) {
    res.status(409).json({ error: `An inverter for brand "${brand}" is already connected` });
    return;
  }

  const inverterId = `${brand.toLowerCase()}-${uuidv4().slice(0, 8)}`;
  const encryptedCredentials = encryptCredentials(credentials);

  const connection = await prisma.inverterConnection.create({
    data: {
      userId: req.userId!,
      inverterId,
      brand,
      credentials: encryptedCredentials,
      isActive: true,
    },
  });

  res.status(201).json({
    id: connection.id,
    inverterId: connection.inverterId,
    brand: connection.brand,
    isActive: connection.isActive,
    connectedAt: connection.createdAt,
    connectionTest: testResult.message,
  });
});

router.post('/test-connection', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { brand, credentials } = req.body as {
    brand: string;
    credentials: Record<string, string>;
  };

  if (!brand || !credentials) {
    res.status(400).json({ error: 'brand and credentials are required' });
    return;
  }

  try {
    const adapter = getAdapter(brand);
    const result = await adapter.testConnection(credentials);
    res.json(result);
  } catch (err) {
    res.status(502).json({ success: false, message: String(err) });
  }
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

router.get('/brands', (_req, res: Response): void => {
  const brands = SUPPORTED_BRANDS.map(brand => ({
    brand,
    credentialFields: BRAND_CREDENTIAL_FIELDS[brand],
  }));
  res.json({ brands });
});

export default router;

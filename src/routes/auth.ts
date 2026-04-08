import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import prisma from '../db/client';
import { config } from '../config/env';

const router = Router();

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { email, password, walletAddress } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  // Validate wallet address if provided, otherwise generate one
  let wallet = walletAddress;
  if (wallet && !ethers.isAddress(wallet)) {
    res.status(400).json({ error: 'Invalid wallet address' });
    return;
  }
  if (!wallet) {
    wallet = ethers.Wallet.createRandom().address;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, password: hashed, walletAddress: wallet },
  });

  const token = jwt.sign({ userId: user.id, walletAddress: user.walletAddress }, config.jwtSecret, {
    expiresIn: '7d',
  });

  res.status(201).json({ token, userId: user.id, walletAddress: user.walletAddress });
});

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign({ userId: user.id, walletAddress: user.walletAddress }, config.jwtSecret, {
    expiresIn: '7d',
  });

  res.json({ token, userId: user.id, walletAddress: user.walletAddress });
});

export default router;

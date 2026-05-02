import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/emailService';
import prisma from '../db/client';
import { config } from '../config/env';
import { AuthRequest, requireAuth } from '../middleware/auth';

const router = Router();

// Helper to validate wallet address (basic)
function isValidWalletAddress(addr: string): boolean {
  if (typeof addr !== 'string') return false;
  // Accept any non-empty string with reasonable length (Solana: ~44, ETH: 42)
  return addr.length >= 32 && addr.length <= 100;
}

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, walletAddress } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    // Validate walletAddress if provided
    let wallet = walletAddress;
    if (wallet) {
      if (!isValidWalletAddress(wallet)) {
        res.status(400).json({ error: 'Invalid wallet address format' });
        return;
      }
    } else {
      // No wallet provided — generate random ETH wallet (fallback)
      wallet = ethers.Wallet.createRandom().address;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);

    // Generate 6-digit verification code (10 min expiry)
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const codeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashed,
        walletAddress: wallet,
        verificationCode,
        codeExpiresAt,
      },
    });

    // Send verification email (non-blocking)
    try {
      await sendVerificationEmail(email, verificationCode);
    } catch (err) {
      console.error('[verify] Failed to send email:', err);
    }

    const token = jwt.sign({ userId: user.id, walletAddress: user.walletAddress }, config.jwtSecret, {
      expiresIn: '7d',
    });

    res.status(201).json({ 
      token, 
      userId: user.id, 
      walletAddress: user.walletAddress,
      message: 'Check your email for a verification code',
    });
  } catch (err) {
    console.error('[register] ERROR:', err);
    if (err instanceof Error) {
      console.error('[register] Stack:', err.stack);
    }
    res.status(500).json({ error: 'Internal server error', details: err instanceof Error ? err.message : String(err) });
  }
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

// Optional: verify token and return user info
router.get('/me', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { id: true, email: true, walletAddress: true },
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});



// Email verification
router.post('/verify', async (req: Request, res: Response): Promise<void> => {
  const { email, code } = req.body;

  if (!email || !code) {
    res.status(400).json({ error: 'email and code are required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (user.emailVerified) {
    res.status(200).json({ message: 'Already verified' });
    return;
  }

  if (!user.verificationCode || user.verificationCode !== code) {
    res.status(400).json({ error: 'Invalid verification code' });
    return;
  }

  if (!user.codeExpiresAt || new Date() > user.codeExpiresAt) {
    res.status(400).json({ error: 'Verification code expired' });
    return;
  }

  await prisma.user.update({
    where: { email },
    data: { emailVerified: true, verificationCode: null, codeExpiresAt: null },
  });

  res.json({ message: 'Email verified successfully' });
});

// Resend verification code
router.post('/resend-code', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (user.emailVerified) {
    res.status(200).json({ message: 'Already verified' });
    return;
  }

  // Generate new code (6 digits)
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await prisma.user.update({
    where: { email },
    data: { verificationCode: code, codeExpiresAt: expiresAt },
  });

  // TODO: Send email via Resend
  console.log(`[verify] Code for ${email}: ${code}`);

  res.json({ message: 'Verification code sent' });
});


// Forgot password — send reset code
router.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // Always respond the same way to prevent email enumeration
  if (!user) {
    res.json({ message: 'If that email exists, a reset code has been sent.' });
    return;
  }

  // Rate limit: max 3 requests per hour
  const now = new Date();
  const windowStart = user.resetWindowStart;
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  let attempts = user.resetAttempts;
  if (!windowStart || windowStart < oneHourAgo) {
    // Window expired — reset counter
    attempts = 0;
  }

  if (attempts >= 3) {
    res.status(429).json({ error: 'Too many reset requests. Please wait an hour before trying again.' });
    return;
  }

  const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
  const resetCodeExpiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes

  await prisma.user.update({
    where: { email },
    data: {
      resetCode,
      resetCodeExpiresAt,
      resetAttempts: attempts + 1,
      resetWindowStart: attempts === 0 ? now : (windowStart ?? now),
    },
  });

  try {
    await sendPasswordResetEmail(email, resetCode);
    console.log(`[forgot-password] Email dispatched to ${email}`);
  } catch (err) {
    console.error('[forgot-password] EMAIL SEND FAILED for', email, '—', err);
  }

  res.json({ message: 'If that email exists, a reset code has been sent.' });
});

// Reset password — verify code and update password
router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
  const { email, code, newPassword } = req.body;

  if (!email || !code || !newPassword) {
    res.status(400).json({ error: 'email, code, and newPassword are required' });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(400).json({ error: 'Invalid or expired reset code' });
    return;
  }

  if (!user.resetCode || user.resetCode !== code) {
    res.status(400).json({ error: 'Invalid reset code' });
    return;
  }

  if (!user.resetCodeExpiresAt || new Date() > user.resetCodeExpiresAt) {
    res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
    return;
  }

  const hashed = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { email },
    data: {
      password: hashed,
      resetCode: null,
      resetCodeExpiresAt: null,
      resetAttempts: 0,
      resetWindowStart: null,
    },
  });

  res.json({ message: 'Password reset successfully' });
});

// Export wallet (private key) — JWT protected
router.get('/wallet/export', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, walletAddress: true },
  });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Get private key from localStorage on frontend? We can't retrieve it server-side.
  // Instead, return the wallet address; private key stays on client side
  // Client will package their stored privateKey into the download
  res.json({
    address: user.walletAddress,
    email: user.email,
    exportedAt: new Date().toISOString(),
    note: 'Private key is stored locally in your browser. Use your wallet app to import using the backup file.',
  });
});


export default router;

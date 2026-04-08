import '../src/config/env';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { ethers } from 'ethers';

const prisma = new PrismaClient();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY!;

async function main() {
  // Derive the deployer's wallet address from the private key
  const wallet = new ethers.Wallet(DEPLOYER_PRIVATE_KEY);
  const walletAddress = wallet.address;

  console.log(`[seed] Deployer wallet address: ${walletAddress}`);

  // Create test user (or update if already exists)
  const passwordHash = await bcrypt.hash('password123', 10);

  const user = await prisma.user.upsert({
    where: { email: 'test@subsidized.energy' },
    update: {},
    create: {
      email: 'test@subsidized.energy',
      password: passwordHash,
      walletAddress,
    },
  });

  console.log(`[seed] Test user: ${user.email} (id: ${user.id})`);

  // Connect a mock inverter
  const inverterId = 'mock-solarman-001';

  const inverter = await prisma.inverterConnection.upsert({
    where: { inverterId },
    update: {},
    create: {
      userId: user.id,
      inverterId,
      brand: 'Solarman',
      apiKey: 'mock-api-key-12345',
      isActive: true,
    },
  });

  console.log(`[seed] Mock inverter connected: ${inverter.inverterId} (id: ${inverter.id})`);
  console.log(`\n[seed] Done!`);
  console.log(`\nTest credentials:`);
  console.log(`  Email:    test@subsidized.energy`);
  console.log(`  Password: password123`);
  console.log(`  Wallet:   ${walletAddress}`);
}

main()
  .catch((err) => {
    console.error('[seed] Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

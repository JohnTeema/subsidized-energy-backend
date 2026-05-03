#!/usr/bin/env tsx
/**
 * One-time script to award retroactive SRE connection bonuses.
 *
 * Awards 3 SRE points to every user who:
 * - Has at least one active inverter connection
 * - Has srePoints === 0
 * - Has no prior SrePointsLog entry with reason 'inverter_connection_bonus'
 *
 * Usage: npm run award:bonus
 *   or: RUN_RETROACTIVE_BONUS=true npm start   (runs on server startup)
 */

import prisma from '../src/db/client';
import { awardSrePoints } from '../src/services/srePointsService';

async function run(): Promise<void> {
  console.log('[retroactive-bonus] Starting...');

  // Find all users with active inverter connections
  const activeUsers = await prisma.inverterConnection.findMany({
    where: { isActive: true },
    select: { userId: true },
    distinct: ['userId'],
  });

  const userIds = activeUsers.map(u => u.userId);
  console.log(`[retroactive-bonus] Found ${userIds.length} users with active inverters`);

  let awardedCount = 0;
  let skippedCount = 0;

  for (const userId of userIds) {
    // Check user's current srePoints and prior logs
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        srePoints: true,
        srePointsLogs: { where: { reason: 'inverter_connection_bonus' }, take: 1 },
      },
    });

    if (!user) {
      skippedCount++;
      continue;
    }

    if (user.srePoints > 0 || user.srePointsLogs.length > 0) {
      skippedCount++;
      continue;
    }

    // Award 3 points
    await awardSrePoints({
      userId,
      amount: 3,
      reason: 'inverter_connection_bonus',
      meta: { retroactive: true, awardedAt: new Date().toISOString() },
    });
    awardedCount++;
    console.log(`[retroactive-bonus] Awarded 3 points to ${userId}`);
  }

  console.log(`[retroactive-bonus] Complete — awarded: ${awardedCount}, skipped: ${skippedCount}`);
}

run().catch((err) => {
  console.error('[retroactive-bonus] FATAL:', err);
  process.exit(1);
});

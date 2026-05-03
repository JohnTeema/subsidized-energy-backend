import prisma from '../db/client';

export const SRE_POINTS_REASONS = {
  INVERTER_CONNECTION_BONUS: 'inverter_connection_bonus',
  DAILY_PRODUCTION: 'daily_production',
  REFERRAL: 'referral',
  AIRDROP: 'airdrop',
} as const;

export type SrePointsReason = (typeof SRE_POINTS_REASONS)[keyof typeof SRE_POINTS_REASONS];

export interface AwardSrePointsParams {
  userId: string;
  amount: number;
  reason: SrePointsReason;
  meta?: Record<string, unknown>;
}

/**
 * Awards SRE points to a user and logs the transaction.
 */
export async function awardSrePoints(params: AwardSrePointsParams): Promise<void> {
  const { userId, amount, reason, meta } = params;

  if (amount <= 0) return;

  await prisma.$transaction([
    // Update user's total SRE points
    prisma.user.update({
      where: { id: userId },
      data: {
        srePoints: { increment: amount },
      },
    }),
    // Create log entry
    prisma.srePointsLog.create({
      data: {
        userId,
        amount,
        reason,
        ...(meta ? { meta: meta as any } : {}),
      },
    }),
  ]);
}

/**
 * Calculates SRE points for daily production using emission curve:
 * points = baseRate / (1 + 0.01 * totalProducers) * kWh
 * For now baseRate = 1 (roughly 1 point per kWh)
 *
 * @param kWh - Total kWh produced that day
 * @param totalProducers - Total number of active producers (inverters)
 * @returns SRE points to award
 */
export function calculateDailyProductionPoints(kWh: number, totalProducers: number): number {
  const baseRate = 1;
  const multiplier = baseRate / (1 + 0.01 * totalProducers);
  return kWh * multiplier;
}

/**
 * Gets the current SRE points balance for a user.
 */
export async function getUserSrePoints(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { srePoints: true },
  });
  return user?.srePoints ?? 0;
}

/**
 * Gets SRE points history for a user, ordered by date descending.
 */
export async function getUserSrePointsHistory(userId: string, limit = 50) {
  return prisma.srePointsLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * One-time retroactive bonus: award 3 SRE points to users with active
 * inverter connections but 0 srePoints and no prior inverter_connection_bonus.
 */
export async function awardRetroactiveInverterBonuses(): Promise<number> {
  // Find all users with active inverter connections
  const activeUsers = await prisma.inverterConnection.findMany({
    where: { isActive: true },
    select: { userId: true },
    distinct: ['userId'],
  });

  const userIds = activeUsers.map(u => u.userId);

  let awardedCount = 0;

  for (const userId of userIds) {
    // Check if user already has any srePoints
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { srePoints: true, srePointsLogs: { where: { reason: 'inverter_connection_bonus' }, take: 1 } },
    });

    if (!user) continue;

    // Skip if user already has srePoints > 0 or already has a connection bonus log
    if (user.srePoints > 0 || user.srePointsLogs.length > 0) continue;

    // Award 3 points
    await awardSrePoints({
      userId,
      amount: 3,
      reason: 'inverter_connection_bonus',
      meta: { retroactive: true, awardedAt: new Date().toISOString() },
    });
    awardedCount++;
  }

  return awardedCount;
}

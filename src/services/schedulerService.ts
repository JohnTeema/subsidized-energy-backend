import cron from 'node-cron';
import prisma from '../db/client';
import { validateReading } from './validationEngine';
import { recordProduction } from './blockchainRouter';
import { getAdapter } from '../adapters';
import { decryptCredentials } from '../utils/credentialsCrypto';
import * as crypto from 'crypto';
import { awardSrePoints, calculateDailyProductionPoints } from './srePointsService';

export interface SimulateResult {
  inverterId: string;
  userId: string;
  walletAddress: string;
  kwhProduced: number;
  validated: boolean;
  validationError?: string;
  txHash?: string;
  recordId?: number;
  subBalance?: string;
  sreBalance?: string;
}

// Polls all active inverters and saves readings to the database.
// Does NOT write to the blockchain — that happens once per day via runDailyRecording().
export async function runPollingCycle(): Promise<SimulateResult[]> {
  const results: SimulateResult[] = [];

  const connections = await prisma.inverterConnection.findMany({
    where: { isActive: true },
    include: { user: true },
  });

  if (connections.length === 0) {
    console.log('[scheduler] No active inverter connections found');
    return results;
  }

  const intervalEnd = new Date();
  const intervalStart = new Date(intervalEnd.getTime() - 15 * 60 * 1000);

  for (const conn of connections) {
    const result: SimulateResult = {
      inverterId: conn.id,
      userId: conn.userId,
      walletAddress: conn.user.walletAddress,
      kwhProduced: 0,
      validated: false,
    };

    try {
      const credentials = decryptCredentials(conn.credentials);
      const adapter = getAdapter(conn.brand);

      console.log(`[scheduler] Fetching energy for ${conn.inverterId} via ${conn.brand} adapter`);

      const reading = await adapter.fetchEnergy(
        credentials,
        conn.inverterId,
        conn.userId,
        intervalStart,
        intervalEnd,
      );

      result.kwhProduced = reading.kwh_produced;

      const simulatedReading = {
        inverterId: conn.inverterId,
        kwhProduced: reading.kwh_produced,
        intervalStart,
        intervalEnd,
        rawData: { ...reading } as Record<string, unknown>,
      };

      const validation = await validateReading(simulatedReading, conn.id);
      result.validated = validation.valid;
      result.validationError = validation.error;

      await prisma.energyReading.create({
        data: {
          inverterId: conn.id,
          userId: conn.userId,
          kwhProduced: reading.kwh_produced,
          readingType: 'snapshot',
          intervalStart,
          intervalEnd,
          rawDataHash: reading.raw_hash,
          validated: validation.valid,
          validationError: validation.error ?? null,
        },
      });

      if (!validation.valid) {
        console.log(`[scheduler] Reading invalid for ${conn.inverterId}: ${validation.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Error polling inverter ${conn.inverterId} (${conn.brand}): ${msg}`);
      result.validationError = msg;
    }

    results.push(result);
  }

  return results;
}

// Aggregates today's validated readings and submits one on-chain record per inverter.
// Skips inverters that have already been recorded today.
export async function runDailyRecording(): Promise<SimulateResult[]> {
  const results: SimulateResult[] = [];

  const connections = await prisma.inverterConnection.findMany({
    where: { isActive: true },
    include: { user: true },
  });

  if (connections.length === 0) {
    console.log('[scheduler:daily] No active inverter connections found');
    return results;
  }

  // Total number of active producers (used for emission curve multiplier)
  const totalProducers = connections.length;

  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  for (const conn of connections) {
    const result: SimulateResult = {
      inverterId: conn.id,
      userId: conn.userId,
      walletAddress: conn.user.walletAddress,
      kwhProduced: 0,
      validated: false,
    };

    try {
      // Skip if we already minted $SUB for this inverter today
      if (conn.lastRecordedDate) {
        const lastDate = new Date(conn.lastRecordedDate);
        lastDate.setUTCHours(0, 0, 0, 0);
        if (lastDate.getTime() === todayUtc.getTime()) {
          console.log(`[scheduler:daily] ${conn.inverterId} already recorded today — skipping`);
          continue;
        }
      }

      // Sum all validated readings for today
      const todayEnd = new Date(todayUtc.getTime() + 24 * 60 * 60 * 1000);
      const readings = await prisma.energyReading.findMany({
        where: {
          inverterId: conn.id,
          validated: true,
          intervalStart: { gte: todayUtc, lt: todayEnd },
        },
      });

      if (readings.length === 0) {
        console.log(`[scheduler:daily] No validated readings today for ${conn.inverterId} — skipping`);
        continue;
      }

      // epvToday is cumulative — the highest value is the true daily production
      const dailyKwh = Math.max(...readings.map((r) => r.kwhProduced));
      result.kwhProduced = dailyKwh;
      result.validated = true;

      // Deterministic hash of all today's raw data hashes combined
      const combinedHash = crypto
        .createHash('sha256')
        .update(readings.map((r) => r.rawDataHash).join(''))
        .digest('hex');

      const intervalStart = readings[0].intervalStart;
      const intervalEnd = readings[readings.length - 1].intervalEnd;

      console.log(
        `[scheduler:daily] Recording ${dailyKwh.toFixed(3)} kWh on-chain for ${conn.inverterId} ` +
        `(MAX of ${readings.length} snapshots, chains: ${process.env.ACTIVE_CHAINS || 'base,solana'})`,
      );

      const onChain = await recordProduction(
        conn.user.walletAddress,
        conn.inverterId,
        dailyKwh,
        intervalStart,
        intervalEnd,
        combinedHash,
      );

      console.log(`[scheduler:daily] Recorded on chains: [${onChain.chains.join(', ')}]`);

      const baseResult = onChain.base;
      const solanaResult = onChain.solana;

      // Create a single authoritative daily_total reading for this day
      await prisma.energyReading.create({
        data: {
          inverterId: conn.id,
          userId: conn.userId,
          kwhProduced: dailyKwh,
          readingType: 'daily_total',
          intervalStart,
          intervalEnd,
          rawDataHash: combinedHash,
          validated: true,
          txHash: baseResult?.txHash ?? solanaResult?.txSignature ?? null,
          onChainRecordId: baseResult?.recordId ?? null,
          subMinted: parseFloat(baseResult?.subMinted ?? solanaResult?.subMinted ?? '0'),
          sreMinted: parseFloat(baseResult?.sreMinted ?? solanaResult?.sreMinted ?? '0'),
        },
      });

      // Award SRE points for today's production using emission curve
      const productionPoints = calculateDailyProductionPoints(dailyKwh, totalProducers);
      await awardSrePoints({
        userId: conn.userId,
        amount: productionPoints,
        reason: 'daily_production',
        meta: {
          inverterId: conn.inverterId,
          dailyKwh,
          totalProducers,
          date: todayUtc.toISOString().split('T')[0],
        },
      });

      // Mark inverter as recorded for today
      await prisma.inverterConnection.update({
        where: { id: conn.id },
        data: { lastRecordedDate: new Date() },
      });

      result.txHash = baseResult?.txHash ?? solanaResult?.txSignature;
      result.recordId = baseResult?.recordId;
      result.subBalance = baseResult?.subMinted ?? solanaResult?.subMinted;
      result.sreBalance = baseResult?.sreMinted ?? solanaResult?.sreMinted;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler:daily] Error recording inverter ${conn.inverterId}: ${msg}`);
      result.validationError = msg;
    }

    results.push(result);
  }

  return results;
}

// Keep legacy export so dev/admin routes that call runSimulationCycle() still work
export const runSimulationCycle = runPollingCycle;

export function startScheduler(): void {
  // Every 15 minutes: poll inverters and save readings to DB
  cron.schedule('*/15 * * * *', async () => {
    console.log('[scheduler] Running polling cycle...');
    await runPollingCycle();
  });

  // Once per day at 23:58 UTC: aggregate readings and mint $SUB on-chain
  cron.schedule('58 23 * * *', async () => {
    console.log('[scheduler:daily] Running daily on-chain recording...');
    await runDailyRecording();
  }, { timezone: 'UTC' });

  console.log('[scheduler] Cron started — polls every 15 min, records on-chain daily at 23:58 UTC');
}

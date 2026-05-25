import cron from 'node-cron';
import { config } from '../config/env';
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

async function calculateRecordedKwh(
  brand: string,
  inverterConnectionId: string,
  reading: Awaited<ReturnType<ReturnType<typeof getAdapter>['fetchEnergy']>>,
): Promise<number> {
  if (brand !== 'growatt') {
    return reading.kwh_produced;
  }

  const currentCumulative =
    typeof reading.epv_total === 'number' && reading.epv_total > 0
      ? reading.epv_total
      : reading.epv_today;

  if (typeof currentCumulative !== 'number') {
    return reading.kwh_produced;
  }

  const previous = await prisma.energyReading.findFirst({
    where: {
      inverterId: inverterConnectionId,
      readingType: 'snapshot',
      validated: true,
      OR: [
        { epvTotal: { not: null } },
        { epvToday: { not: null } },
      ],
    },
    orderBy: { intervalEnd: 'desc' },
    select: {
      epvTotal: true,
      epvToday: true,
      intervalEnd: true,
    },
  });

  if (!previous) {
    console.log(
      `[scheduler] Growatt baseline stored for ${inverterConnectionId}; ` +
      `current cumulative=${currentCumulative.toFixed(4)} kWh, interval delta=0`,
    );
    return 0;
  }

  const previousCumulative =
    typeof previous.epvTotal === 'number' && previous.epvTotal > 0
      ? previous.epvTotal
      : previous.epvToday;

  if (typeof previousCumulative !== 'number') {
    return 0;
  }

  let delta = currentCumulative - previousCumulative;

  if (delta < 0) {
    const sameUtcDay =
      previous.intervalEnd.toISOString().slice(0, 10) === reading.interval_end.slice(0, 10);

    delta = sameUtcDay ? 0 : (reading.epv_today ?? 0);
  }

  const recordedKwh = Math.max(0, delta);
  console.log(
    `[scheduler] Growatt interval delta for ${inverterConnectionId}: ` +
    `${recordedKwh.toFixed(4)} kWh ` +
    `(current=${currentCumulative.toFixed(4)}, previous=${previousCumulative.toFixed(4)})`,
  );

  return parseFloat(recordedKwh.toFixed(4));
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

      const recordedKwh = await calculateRecordedKwh(conn.brand, conn.id, reading);

      result.kwhProduced = recordedKwh;

      const simulatedReading = {
        inverterId: conn.inverterId,
        kwhProduced: recordedKwh,
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
          kwhProduced: recordedKwh,
          readingType: 'snapshot',
          intervalStart,
          intervalEnd,
          rawDataHash: reading.raw_hash,
          validated: validation.valid,
          validationError: validation.error ?? null,
          panelPower: reading.panel_power ?? null,
          batteryCapacity: reading.battery_capacity ?? null,
          batteryVoltage: reading.battery_voltage ?? null,
          epvTotal: reading.epv_total ?? null,
          epvToday: reading.epv_today ?? null,
        },
      });

      // Keep device metadata on the connection up to date (only writes when fields are missing)
      if (reading.device_serial || reading.plant_name || reading.location) {
        const needsUpdate =
          (!conn.deviceSerial && reading.device_serial) ||
          (!conn.plantName && reading.plant_name) ||
          (!conn.location && reading.location);
        if (needsUpdate) {
          await prisma.inverterConnection.update({
            where: { id: conn.id },
            data: {
              ...(reading.device_serial && !conn.deviceSerial ? { deviceSerial: reading.device_serial } : {}),
              ...(reading.plant_name && !conn.plantName ? { plantName: reading.plant_name } : {}),
              ...(reading.location && !conn.location ? { location: reading.location } : {}),
            },
          });
        }
      }

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
          readingType: 'snapshot',
          validated: true,
          intervalStart: { gte: todayUtc, lt: todayEnd },
        },
        orderBy: { intervalStart: 'asc' },
      });

      if (readings.length === 0) {
        console.log(`[scheduler:daily] No validated readings today for ${conn.inverterId} — skipping`);
        continue;
      }

      const dailyKwh = conn.brand === 'growatt'
        ? Math.max(
            ...readings.map((r) =>
              typeof r.epvToday === 'number' && r.epvToday > 0 ? r.epvToday : r.kwhProduced,
            ),
          )
        : readings.reduce((sum, r) => sum + r.kwhProduced, 0);
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
        `(${conn.brand === 'growatt' ? 'MAX cumulative Growatt snapshot' : 'SUM of interval snapshots'} ` +
        `from ${readings.length} readings, chains: ${config.activeChains.join(',')})`,
      );

      const onChain = await recordProduction(
        conn.user.walletAddress,
        conn.inverterId,
        dailyKwh,
        intervalStart,
        intervalEnd,
        combinedHash,
      );

      const solanaResult = onChain.solana;
      const baseResult = onChain.base;

      console.log(`[scheduler:daily] Chains attempted: [${config.activeChains.join(', ')}]`);
      console.log(`[scheduler:daily] Chains recorded:  [${onChain.chains.join(', ') || 'NONE'}]`);
      if (solanaResult) {
        console.log(`[scheduler:daily] Solana tx sig: ${solanaResult.txSignature}`);
      }
      if (Object.keys(onChain.errors).length > 0) {
        console.error(`[scheduler:daily] Chain errors:`, onChain.errors);
      }

      if (onChain.chains.length === 0) {
        const errorSummary = Object.entries(onChain.errors)
          .map(([chain, msg]) => `${chain}: ${msg}`)
          .join('; ');
        throw new Error(`All blockchain chains failed — ${errorSummary || 'unknown error'}`);
      }

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

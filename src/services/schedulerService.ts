import cron from 'node-cron';
import prisma from '../db/client';
import { generateReading } from './mockSimulator';
import { validateReading } from './validationEngine';
import { recordProduction, hashRawData } from './blockchainService';

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

export async function runSimulationCycle(): Promise<SimulateResult[]> {
  const results: SimulateResult[] = [];

  // Get all active inverter connections with their users
  const connections = await prisma.inverterConnection.findMany({
    where: { isActive: true },
    include: { user: true },
  });

  if (connections.length === 0) {
    console.log('[scheduler] No active inverter connections found');
    return results;
  }

  for (const conn of connections) {
    const result: SimulateResult = {
      inverterId: conn.id,
      userId: conn.userId,
      walletAddress: conn.user.walletAddress,
      kwhProduced: 0,
      validated: false,
    };

    try {
      // 1. Generate mock reading
      const reading = generateReading(conn.inverterId);
      result.kwhProduced = reading.kwhProduced;

      // 2. Validate
      const validation = await validateReading(reading, conn.id);
      result.validated = validation.valid;
      result.validationError = validation.error;

      const rawDataHash = hashRawData(reading.rawData);

      // 3. Persist reading (regardless of validity, for audit trail)
      const saved = await prisma.energyReading.create({
        data: {
          inverterId: conn.id,
          userId: conn.userId,
          kwhProduced: reading.kwhProduced,
          intervalStart: reading.intervalStart,
          intervalEnd: reading.intervalEnd,
          rawDataHash,
          validated: validation.valid,
          validationError: validation.error ?? null,
        },
      });

      if (!validation.valid) {
        console.log(`[scheduler] Reading invalid for ${conn.inverterId}: ${validation.error}`);
        results.push(result);
        continue;
      }

      // 4. Submit to blockchain
      console.log(`[scheduler] Submitting ${reading.kwhProduced} kWh to blockchain for ${conn.user.walletAddress}`);
      const onChain = await recordProduction(
        conn.user.walletAddress,
        conn.inverterId,
        reading.kwhProduced,
        reading.intervalStart,
        reading.intervalEnd,
        rawDataHash,
      );

      // 5. Update DB record with on-chain data
      await prisma.energyReading.update({
        where: { id: saved.id },
        data: {
          txHash: onChain.txHash,
          onChainRecordId: onChain.recordId,
          subMinted: parseFloat(onChain.subMinted),
          sreMinted: parseFloat(onChain.sreMinted),
        },
      });

      result.txHash = onChain.txHash;
      result.recordId = onChain.recordId;
      result.subBalance = onChain.subMinted;
      result.sreBalance = onChain.sreMinted;

      console.log(`[scheduler] Recorded on-chain. tx=${onChain.txHash} recordId=${onChain.recordId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Error processing inverter ${conn.inverterId}: ${msg}`);
      result.validationError = msg;
    }

    results.push(result);
  }

  return results;
}

export function startScheduler(): void {
  // Run every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    console.log('[scheduler] Running scheduled simulation cycle...');
    await runSimulationCycle();
  });

  console.log('[scheduler] Cron started — runs every 15 minutes');
}

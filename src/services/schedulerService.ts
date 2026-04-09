import cron from 'node-cron';
import prisma from '../db/client';
import { validateReading } from './validationEngine';
import { recordProduction } from './blockchainService';
import { getAdapter } from '../adapters';
import { decryptCredentials } from '../utils/credentialsCrypto';

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
      // Decrypt credentials for this inverter
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

      // Build the SimulatedReading-compatible shape for validationEngine
      const simulatedReading = {
        inverterId: conn.inverterId,
        kwhProduced: reading.kwh_produced,
        intervalStart,
        intervalEnd,
        rawData: { ...reading } as Record<string, unknown>,
      };

      // Validate
      const validation = await validateReading(simulatedReading, conn.id);
      result.validated = validation.valid;
      result.validationError = validation.error;

      // Persist reading (regardless of validity, for audit trail)
      const saved = await prisma.energyReading.create({
        data: {
          inverterId: conn.id,
          userId: conn.userId,
          kwhProduced: reading.kwh_produced,
          intervalStart,
          intervalEnd,
          rawDataHash: reading.raw_hash,
          validated: validation.valid,
          validationError: validation.error ?? null,
        },
      });

      if (!validation.valid) {
        console.log(`[scheduler] Reading invalid for ${conn.inverterId}: ${validation.error}`);
        results.push(result);
        continue;
      }

      // Submit to blockchain
      console.log(`[scheduler] Submitting ${reading.kwh_produced} kWh to blockchain for ${conn.user.walletAddress}`);
      const onChain = await recordProduction(
        conn.user.walletAddress,
        conn.inverterId,
        reading.kwh_produced,
        intervalStart,
        intervalEnd,
        reading.raw_hash,
      );

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
      console.error(`[scheduler] Error processing inverter ${conn.inverterId} (${conn.brand}): ${msg}`);
      result.validationError = msg;
    }

    results.push(result);
  }

  return results;
}

export function startScheduler(): void {
  cron.schedule('*/15 * * * *', async () => {
    console.log('[scheduler] Running polling cycle...');
    await runSimulationCycle();
  });

  console.log('[scheduler] Cron started — runs every 15 minutes');
}

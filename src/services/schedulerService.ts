import cron from 'node-cron';
import prisma from '../db/client';
import { validateReading } from './validationEngine';
import { recordProduction } from './blockchainRouter';
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

      // Submit to blockchain(s)
      console.log(`[scheduler] Submitting ${reading.kwh_produced} kWh to chains: ${process.env.ACTIVE_CHAINS || 'base,solana'}`);
      const onChain = await recordProduction(
        conn.user.walletAddress,
        conn.inverterId,
        reading.kwh_produced,
        intervalStart,
        intervalEnd,
        reading.raw_hash,
      );

      console.log(`[scheduler] Recorded on chains: [${onChain.chains.join(', ')}]`);

      // Persist whichever chain(s) succeeded (prefer Base for stored fields)
      const baseResult = onChain.base;
      const solanaResult = onChain.solana;

      await prisma.energyReading.update({
        where: { id: saved.id },
        data: {
          txHash: baseResult?.txHash ?? solanaResult?.txSignature ?? null,
          onChainRecordId: baseResult?.recordId ?? null,
          subMinted: parseFloat(baseResult?.subMinted ?? solanaResult?.subMinted ?? '0'),
          sreMinted: parseFloat(baseResult?.sreMinted ?? solanaResult?.sreMinted ?? '0'),
        },
      });

      result.txHash = baseResult?.txHash ?? solanaResult?.txSignature;
      result.recordId = baseResult?.recordId;
      result.subBalance = baseResult?.subMinted ?? solanaResult?.subMinted;
      result.sreBalance = baseResult?.sreMinted ?? solanaResult?.sreMinted;
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

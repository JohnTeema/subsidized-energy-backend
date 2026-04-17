import { config } from '../config/env';
import * as base from './blockchainService';
import * as solana from './solanaBlockchainService';
import type { RecordResult } from './blockchainService';
import type { SolanaRecordResult } from './solanaBlockchainService';

export interface RouterRecordResult {
  base?: RecordResult;
  solana?: SolanaRecordResult;
  chains: string[];
}

export interface RouterBalances {
  base?: { sub: string; sre: string };
  solana?: { sub: string; sre: string };
}

export async function recordProduction(
  producerAddress: string,
  inverterId: string,
  kwhProduced: number,
  intervalStart: Date,
  intervalEnd: Date,
  rawDataHash: string,
  chains?: string[],
): Promise<RouterRecordResult> {
  const activeChains = chains ?? config.activeChains;
  const result: RouterRecordResult = { chains: [] };

  const tasks: Promise<void>[] = [];

  if (activeChains.includes('base')) {
    tasks.push(
      base
        .recordProduction(producerAddress, inverterId, kwhProduced, intervalStart, intervalEnd, rawDataHash)
        .then(r => {
          result.base = r;
          result.chains.push('base');
          console.log(`[router] Base: tx=${r.txHash} sub=${r.subMinted} sre=${r.sreMinted}`);
        })
        .catch(err => {
          console.error(`[router] Base recordProduction failed: ${err instanceof Error ? err.message : err}`);
        }),
    );
  }

  if (activeChains.includes('solana')) {
    tasks.push(
      solana
        .recordProduction(producerAddress, inverterId, kwhProduced, intervalStart, intervalEnd, rawDataHash)
        .then(r => {
          result.solana = r;
          result.chains.push('solana');
          console.log(`[router] Solana: sig=${r.txSignature} sub=${r.subMinted} sre=${r.sreMinted}`);
        })
        .catch(err => {
          console.error(`[router] Solana recordProduction failed: ${err instanceof Error ? err.message : err}`);
        }),
    );
  }

  await Promise.all(tasks);
  return result;
}

export async function getBalances(address: string, chain?: string): Promise<RouterBalances> {
  const result: RouterBalances = {};
  const tasks: Promise<void>[] = [];

  const wantBase = !chain || chain === 'base' || chain === 'both';
  const wantSolana = !chain || chain === 'solana' || chain === 'both';

  if (wantBase && config.activeChains.includes('base')) {
    tasks.push(
      base
        .getBalances(address)
        .then(b => { result.base = b; })
        .catch(() => { result.base = { sub: '0', sre: '0' }; }),
    );
  }

  if (wantSolana && config.activeChains.includes('solana')) {
    tasks.push(
      solana
        .getBalances(address)
        .then(b => { result.solana = b; })
        .catch(() => { result.solana = { sub: '0', sre: '0' }; }),
    );
  }

  await Promise.all(tasks);
  return result;
}

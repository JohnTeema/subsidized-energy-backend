import { ethers } from 'ethers';
import crypto from 'crypto';
import { config } from '../config/env';

import EnergyRegistryAbi from '../abis/EnergyRegistry.json';
import SUBTokenAbi from '../abis/SUBToken.json';
import SRETokenAbi from '../abis/SREToken.json';

let provider: ethers.JsonRpcProvider;
let signer: ethers.Wallet;
let energyRegistry: ethers.Contract;
let subToken: ethers.Contract;
let sreToken: ethers.Contract;

export function initBlockchain(): void {
  provider = new ethers.JsonRpcProvider(config.rpcUrl);
  signer = new ethers.Wallet(config.deployerPrivateKey, provider);

  energyRegistry = new ethers.Contract(
    config.contracts.energyRegistry,
    EnergyRegistryAbi.abi,
    signer,
  );

  subToken = new ethers.Contract(config.contracts.subToken, SUBTokenAbi.abi, signer);
  sreToken = new ethers.Contract(config.contracts.sreToken, SRETokenAbi.abi, signer);

  console.log(`[blockchain] Initialized. Signer: ${signer.address}`);
}

export function getSignerAddress(): string {
  return signer?.address ?? '';
}

export interface RecordResult {
  txHash: string;
  recordId: number;
  subMinted: string;
  sreMinted: string;
}

export async function recordProduction(
  producerAddress: string,
  inverterId: string,
  kwhProduced: number,
  intervalStart: Date,
  intervalEnd: Date,
  rawDataHash: string,
): Promise<RecordResult> {
  // Contract uses 2-decimal fixed-point kWh (375 = 3.75 kWh)
  // Tokens use 18 decimals; subAmount = kwhProduced * 1e16
  const kwhInt = Math.round(kwhProduced * 100);
  const startTs = Math.floor(intervalStart.getTime() / 1000);
  const endTs = Math.floor(intervalEnd.getTime() / 1000);
  const hashBytes32 = '0x' + rawDataHash.padEnd(64, '0');

  const tx = await energyRegistry.recordProduction(
    producerAddress,
    inverterId,
    kwhInt,
    startTs,
    endTs,
    hashBytes32,
  );

  const receipt = await tx.wait();

  // Parse ProductionRecorded event to get the recordId
  let recordId = 0;
  for (const log of receipt.logs) {
    try {
      const parsed = energyRegistry.interface.parseLog(log);
      if (parsed && parsed.name === 'ProductionRecorded') {
        recordId = Number(parsed.args.recordId);
      }
    } catch {
      // Not our event
    }
  }

  // Parse ERC20 Transfer events from token contracts to get minted amounts
  const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
  const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase().slice(2).padStart(64, '0');
  let subMinted = BigInt(0);
  let sreMinted = BigInt(0);

  for (const log of receipt.logs) {
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics[1] !== '0x' + ZERO_ADDRESS) continue; // from == address(0) = mint

    const amount = BigInt(log.data);
    if (log.address.toLowerCase() === config.contracts.subToken.toLowerCase()) {
      subMinted = amount;
    } else if (log.address.toLowerCase() === config.contracts.sreToken.toLowerCase()) {
      sreMinted = amount;
    }
  }

  return {
    txHash: receipt.hash,
    recordId,
    subMinted: ethers.formatUnits(subMinted, 18),
    sreMinted: ethers.formatUnits(sreMinted, 18),
  };
}

export async function getBalances(address: string): Promise<{ sub: string; sre: string }> {
  const [subBal, sreBal] = await Promise.all([
    subToken.balanceOf(address),
    sreToken.balanceOf(address),
  ]);
  return {
    sub: ethers.formatUnits(subBal, 18),
    sre: ethers.formatUnits(sreBal, 18),
  };
}

export function hashRawData(data: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

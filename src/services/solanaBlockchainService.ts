import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/env';
import EnergyRegistryIdl from '../abis/energy_registry_solana.json';

let connection: Connection;
let keypair: Keypair;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let program: anchor.Program<any>;

const PROGRAM_ID = new PublicKey('E93p3yX6mxswv1yBn6gcZvsPCqckyupUVQKuk6YLNyYR');

export interface SolanaRecordResult {
  txSignature: string;
  subMinted: string;
  sreMinted: string;
}

export function initSolanaBlockchain(): void {
  connection = new Connection(config.solana.rpcUrl, 'confirmed');

  let secretKey: number[];
  if (config.solana.privateKey) {
    const raw = config.solana.privateKey.trim();
    try {
      secretKey = JSON.parse(raw);
    } catch {
      secretKey = raw.split(',').map((n) => parseInt(n.trim(), 10));
    }
  } else {
    const keyPath = path.join(process.env.HOME || '', '.config', 'solana', 'id.json');
    secretKey = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  }
  keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program = new anchor.Program(EnergyRegistryIdl as any, provider);

  console.log(`[solana] Initialized. Wallet: ${keypair.publicKey.toBase58()}`);
}

export function getSolanaWalletAddress(): string {
  return keypair?.publicKey.toBase58() ?? '';
}

async function getNetworkState(): Promise<{ subMint: PublicKey; sreMint: PublicKey }> {
  const [networkStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('network_state')],
    PROGRAM_ID,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).networkState.fetch(networkStatePda) as any;
  return { subMint: state.subMint as PublicKey, sreMint: state.sreMint as PublicKey };
}

export async function recordProduction(
  _producerAddress: string,
  inverterId: string,
  kwhProduced: number,
  intervalStart: Date,
  intervalEnd: Date,
  rawDataHash: string,
): Promise<SolanaRecordResult> {
  const { subMint, sreMint } = await getNetworkState();

  const inverterIdHash = Array.from(
    crypto.createHash('sha256').update(inverterId).digest(),
  );
  // rawDataHash is a 64-char hex string from sha256; convert to 32-byte array
  const rawDataHashBytes = Array.from(Buffer.from(rawDataHash.padEnd(64, '0'), 'hex'));

  // Solana program uses whole kWh (not kWh×100 like EVM)
  const kwhWhole = Math.max(1, Math.round(kwhProduced));
  const startTs = Math.floor(intervalStart.getTime() / 1000);
  const endTs = Math.floor(intervalEnd.getTime() / 1000);

  const [networkStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('network_state')],
    PROGRAM_ID,
  );
  const [productionRecordPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('production'),
      keypair.publicKey.toBuffer(),
      Buffer.from(inverterIdHash),
      new BN(startTs).toArrayLike(Buffer, 'le', 8),
    ],
    PROGRAM_ID,
  );
  const [producerRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('producer'), keypair.publicKey.toBuffer()],
    PROGRAM_ID,
  );

  // Ensure ATAs exist (creates them if not)
  const producerSubAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    subMint,
    keypair.publicKey,
  );
  const producerSreAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    sreMint,
    keypair.publicKey,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (program as any).methods;
  const txSig = await methods
    .recordProduction(
      inverterIdHash,
      new BN(startTs),
      new BN(kwhWhole),
      new BN(endTs),
      rawDataHashBytes,
    )
    .accounts({
      producer: keypair.publicKey,
      networkState: networkStatePda,
      productionRecord: productionRecordPda,
      producerRecord: producerRecordPda,
      subMint,
      sreMint,
      producerSubAccount: producerSubAccount.address,
      producerSreAccount: producerSreAccount.address,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await connection.confirmTransaction(txSig, 'confirmed');

  // Read exact amounts from the production record PDA
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recordData = await (program.account as any).productionRecord.fetch(productionRecordPda) as any;
  const subMintedRaw: BN = recordData.subMinted;   // SUB has 0 decimals
  const sreMintedRaw: BN = recordData.sreMinted;   // SRE has 9 decimals

  return {
    txSignature: txSig,
    subMinted: subMintedRaw.toString(),
    sreMinted: (sreMintedRaw.toNumber() / 1e9).toFixed(9),
  };
}

export async function getBalances(_address: string): Promise<{ sub: string; sre: string }> {
  try {
    const { subMint, sreMint } = await getNetworkState();

    const subAta = await getAssociatedTokenAddress(subMint, keypair.publicKey);
    const sreAta = await getAssociatedTokenAddress(sreMint, keypair.publicKey);

    let subBalance = '0';
    let sreBalance = '0';

    try {
      const subAccount = await getAccount(connection, subAta);
      subBalance = subAccount.amount.toString();
    } catch {
      // ATA doesn't exist yet
    }

    try {
      const sreAccount = await getAccount(connection, sreAta);
      sreBalance = (Number(sreAccount.amount) / 1e9).toFixed(9);
    } catch {
      // ATA doesn't exist yet
    }

    return { sub: subBalance, sre: sreBalance };
  } catch (err) {
    console.error('[solana] getBalances error:', err);
    return { sub: '0', sre: '0' };
  }
}

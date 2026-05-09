import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
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
import { config } from '../config/env';
import EnergyRegistryIdl from '../abis/energy_registry_solana.json';

let connection: Connection;
let keypair: Keypair;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let program: anchor.Program<any>;

const PROGRAM_ID = new PublicKey('E93p3yX6mxswv1yBn6gcZvsPCqckyupUVQKuk6YLNyYR');
// Grid-average CO₂ emission factor in grams per kWh
const EMISSION_FACTOR = 500;

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
    console.error('[solana] SOLANA_PRIVATE_KEY not set — skipping init (non-critical)');
    throw new Error('SOLANA_PRIVATE_KEY environment variable is required');
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

async function getNetworkState(): Promise<{
  sreMint: PublicKey;
  treasury: PublicKey;
  ecosystem: PublicKey;
  team: PublicKey;
}> {
  const [networkStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('network_state')],
    PROGRAM_ID,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).networkState.fetch(networkStatePda) as any;
  return {
    sreMint: state.sreMint as PublicKey,
    treasury: state.treasury as PublicKey,
    ecosystem: state.ecosystem as PublicKey,
    team: state.team as PublicKey,
  };
}

export async function recordProduction(
  _producerAddress: string,
  inverterId: string,
  kwhProduced: number,
  _intervalStart: Date,
  _intervalEnd: Date,
  rawDataHash: string,
): Promise<SolanaRecordResult> {
  // Anchor program field is bounded — use only the last 8 chars (the unique UUID suffix)
  const shortInverterId = inverterId.slice(-8);

  // New program records per UTC day, not per 15-min interval
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dateTs = Math.floor(utcMidnight.getTime() / 1000);

  const kwhWhole = Math.max(1, Math.round(kwhProduced));
  const rawDataHashBytes = Array.from(Buffer.from(rawDataHash.padEnd(64, '0'), 'hex'));

  const { sreMint, treasury, ecosystem, team } = await getNetworkState();

  // Each production record gets its own unique SUB token mint
  const subMintKeypair = Keypair.generate();

  const [networkStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('network_state')],
    PROGRAM_ID,
  );
  const [productionRecordPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('production'),
      keypair.publicKey.toBuffer(),
      new BN(dateTs).toArrayLike(Buffer, 'le', 8),
    ],
    PROGRAM_ID,
  );
  const [producerRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('producer'), keypair.publicKey.toBuffer()],
    PROGRAM_ID,
  );

  // Producer's ATA for the new unique SUB mint (program creates it via CPI)
  const producerSubAta = await getAssociatedTokenAddress(
    subMintKeypair.publicKey,
    keypair.publicKey,
  );

  // Ensure SRE ATAs exist for producer and protocol wallets
  const producerSreAccount = await getOrCreateAssociatedTokenAccount(
    connection, keypair, sreMint, keypair.publicKey,
  );
  const treasurySreAta = await getOrCreateAssociatedTokenAccount(
    connection, keypair, sreMint, treasury,
  );
  const ecosystemSreAta = await getOrCreateAssociatedTokenAccount(
    connection, keypair, sreMint, ecosystem,
  );
  const teamSreAta = await getOrCreateAssociatedTokenAccount(
    connection, keypair, sreMint, team,
  );

  console.log('[solana] recordProduction accounts:', {
    producer: keypair.publicKey.toBase58(),
    networkState: networkStatePda.toBase58(),
    subMint: subMintKeypair.publicKey.toBase58(),
    producerSubAta: producerSubAta.toBase58(),
    sreMint: sreMint.toBase58(),
    producerSreAta: producerSreAccount.address.toBase58(),
    treasurySreAta: treasurySreAta.address.toBase58(),
    ecosystemSreAta: ecosystemSreAta.address.toBase58(),
    teamSreAta: teamSreAta.address.toBase58(),
    productionRecord: productionRecordPda.toBase58(),
    producerRecord: producerRecordPda.toBase58(),
  });
  console.log('[solana] recordProduction args:', {
    dateTs,
    inverterId: shortInverterId,
    kwhWhole,
    emissionFactor: EMISSION_FACTOR,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txSig = await (program as any).methods
    .recordProduction(
      new BN(dateTs),
      shortInverterId,
      new BN(kwhWhole),
      new BN(EMISSION_FACTOR),
      rawDataHashBytes,
    )
    .accounts({
      producer: keypair.publicKey,
      networkState: networkStatePda,
      subMint: subMintKeypair.publicKey,
      producerSubAta,
      sreMint,
      producerSreAta: producerSreAccount.address,
      treasurySreAta: treasurySreAta.address,
      ecosystemSreAta: ecosystemSreAta.address,
      teamSreAta: teamSreAta.address,
      productionRecord: productionRecordPda,
      producerRecord: producerRecordPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([subMintKeypair])
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
    ])
    .rpc();

  await connection.confirmTransaction(txSig, 'confirmed');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recordData = await (program.account as any).productionRecord.fetch(productionRecordPda) as any;
  const sreMintedRaw: BN = recordData.sreMinted;

  return {
    txSignature: txSig,
    subMinted: kwhWhole.toString(), // 1 SUB token per kWh in the unique mint
    sreMinted: (sreMintedRaw.toNumber() / 1e9).toFixed(9),
  };
}

export async function getBalances(_address: string): Promise<{ sub: string; sre: string }> {
  try {
    const { sreMint } = await getNetworkState();

    const sreAta = await getAssociatedTokenAddress(sreMint, keypair.publicKey);
    let sreBalance = '0';

    try {
      const sreAccount = await getAccount(connection, sreAta);
      sreBalance = (Number(sreAccount.amount) / 1e9).toFixed(9);
    } catch {
      // ATA doesn't exist yet
    }

    // New program issues unique per-day SUB mints — no single global SUB balance
    return { sub: '0', sre: sreBalance };
  } catch (err) {
    console.error('[solana] getBalances error:', err);
    return { sub: '0', sre: '0' };
  }
}

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

  // Read raw bytes directly instead of going through Anchor's IDL decoder.
  //
  // The on-chain NetworkState was deployed without the `marketplace_program` field
  // (old struct = 5 pubkeys; new IDL struct = 6 pubkeys).  Anchor's decoder fails
  // because it expects 225 bytes of struct data but the account only has ~193.
  //
  // The four keys we need sit at fixed offsets that are identical in both layouts:
  //   offset  0-7  : Anchor discriminator (8 bytes)
  //   offset  8-39 : authority
  //   offset 40-71 : sre_mint    ← pubkey 2 — same in old & new layout
  //   offset 72-103: treasury    ← pubkey 3
  //   offset 104-135: ecosystem  ← pubkey 4
  //   offset 136-167: team       ← pubkey 5
  //
  // `marketplace_program` was added after team in the new struct, so it doesn't
  // shift any of the preceding fields.
  const info = await connection.getAccountInfo(networkStatePda);
  if (!info) {
    throw new Error(`NetworkState account not found at ${networkStatePda.toBase58()}`);
  }

  const data = info.data;
  if (data.length < 136) {
    throw new Error(
      `NetworkState account too small: ${data.length} bytes (need at least 136). ` +
      `The program may need to be reinitialized.`,
    );
  }

  const sreMint   = new PublicKey(data.slice(40,  72));
  const treasury  = new PublicKey(data.slice(72, 104));
  const ecosystem = new PublicKey(data.slice(104, 136));

  let team: PublicKey;
  if (data.length >= 168) {
    team = new PublicKey(data.slice(136, 168));
  } else {
    // Old on-chain layout (137 bytes): `team` field not present — byte 136 is the bump byte.
    // Use the authority pubkey (bytes 8–39) as a stand-in until the account is reinitialized.
    console.warn(
      `[solana] NetworkState is ${data.length} bytes — team field absent. ` +
      `Using authority as team fallback (call /api/admin/reinit-network-state to fix).`,
    );
    team = new PublicKey(data.slice(8, 40));
  }

  return { sreMint, treasury, ecosystem, team };
}

// Wraps an async step with a labeled error that includes the original stack trace.
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  console.log(`[solana] >> ${label}`);
  try {
    const result = await fn();
    console.log(`[solana] << ${label} OK`);
    return result;
  } catch (err) {
    // Some SPL token errors (e.g. TokenOwnerOffCurveError) set .name but leave .message empty.
    // Use both so the log line is always informative.
    const name  = err instanceof Error ? err.name  : '';
    const msg   = err instanceof Error ? err.message : String(err);
    const label_msg = name && name !== 'Error' ? `${name}: ${msg}` : (msg || String(err));
    const stack = err instanceof Error ? err.stack ?? '' : '';
    console.error(`[solana] << ${label} FAILED: ${label_msg}`);
    const frames = stack.split('\n').slice(1, 7).join('\n');
    if (frames) console.error(`[solana]    stack:\n${frames}`);
    throw new Error(`[${label}] ${label_msg}`);
  }
}

export async function recordProduction(
  _producerAddress: string,
  inverterId: string,
  kwhProduced: number,
  _intervalStart: Date,
  _intervalEnd: Date,
  rawDataHash: string,
): Promise<SolanaRecordResult> {
  // Program accepts up to 64 chars; our stored IDs are "brand-xxxxxxxx" (≤16 chars).
  // Keep the full ID for on-chain traceability — remove the old 8-char truncation.
  const safeInverterId = inverterId.slice(0, 64);

  // New program records per UTC day, not per 15-min interval
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dateTs = Math.floor(utcMidnight.getTime() / 1000);

  const kwhWhole = Math.max(1, Math.round(kwhProduced));

  // Normalise to exactly 32 bytes regardless of what rawDataHash contains.
  // Buffer.from(hex, 'hex') is the canonical form Anchor's coder expects for [u8;32].
  const normalised = rawDataHash.replace(/[^0-9a-fA-F]/g, '').padEnd(64, '0').slice(0, 64);
  const rawDataHashBytes = Buffer.from(normalised, 'hex'); // exactly 32 bytes

  console.log('[solana] recordProduction args:', {
    inverterId: safeInverterId,
    inverterId_len: safeInverterId.length,
    dateTs,
    kwhWhole,
    emissionFactor: EMISSION_FACTOR,
    rawDataHash: normalised.slice(0, 16) + '...',
    rawDataHashBytes_len: rawDataHashBytes.length,
  });

  // ── Step 1: fetch network state (sreMint, treasury, ecosystem, team) ──────────
  const { sreMint, treasury, ecosystem, team } = await step(
    'getNetworkState',
    () => getNetworkState(),
  );

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

  // ── Step 2–5: ensure SRE ATAs exist ─────────────────────────────────────────
  // Log every wallet + mint before attempting ATA creation so failures are diagnosable.
  // treasury/ecosystem/team may be PDAs or multisig addresses — allowOwnerOffCurve: true
  // is required for those; it's harmless for normal wallet addresses.
  console.log('[solana] ATA targets:', {
    sreMint: sreMint.toBase58(),
    producer: { address: keypair.publicKey.toBase58(), isOnCurve: PublicKey.isOnCurve(keypair.publicKey.toBytes()) },
    treasury: { address: treasury.toBase58(),          isOnCurve: PublicKey.isOnCurve(treasury.toBytes()) },
    ecosystem: { address: ecosystem.toBase58(),        isOnCurve: PublicKey.isOnCurve(ecosystem.toBytes()) },
    team: { address: team.toBase58(),                  isOnCurve: PublicKey.isOnCurve(team.toBytes()) },
  });

  const producerSreAccount = await step(
    `getOrCreateATA(producer-SRE mint=${sreMint.toBase58().slice(0,8)} owner=${keypair.publicKey.toBase58().slice(0,8)})`,
    () => getOrCreateAssociatedTokenAccount(connection, keypair, sreMint, keypair.publicKey),
  );
  const treasurySreAta = await step(
    `getOrCreateATA(treasury-SRE mint=${sreMint.toBase58().slice(0,8)} owner=${treasury.toBase58().slice(0,8)})`,
    () => getOrCreateAssociatedTokenAccount(connection, keypair, sreMint, treasury, true),
  );
  const ecosystemSreAta = await step(
    `getOrCreateATA(ecosystem-SRE mint=${sreMint.toBase58().slice(0,8)} owner=${ecosystem.toBase58().slice(0,8)})`,
    () => getOrCreateAssociatedTokenAccount(connection, keypair, sreMint, ecosystem, true),
  );
  const teamSreAta = await step(
    `getOrCreateATA(team-SRE mint=${sreMint.toBase58().slice(0,8)} owner=${team.toBase58().slice(0,8)})`,
    () => getOrCreateAssociatedTokenAccount(connection, keypair, sreMint, team, true),
  );

  console.log('[solana] accounts resolved:', {
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

  // ── Step 6: send recordProduction transaction ────────────────────────────────
  const txSig = await step('recordProduction.rpc()', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (program as any).methods
      .recordProduction(
        new BN(dateTs),
        safeInverterId,
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
  });

  console.log(`[solana] tx confirmed pending: ${txSig}`);

  // ── Step 7: wait for confirmation ───────────────────────────────────────────
  await step('confirmTransaction', () =>
    connection.confirmTransaction(txSig, 'confirmed'),
  );

  console.log(`[solana] tx confirmed: ${txSig}`);

  // ── Step 8: fetch and decode the production record ───────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recordData: any = await step('productionRecord.fetch()', () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (program.account as any).productionRecord.fetch(productionRecordPda),
  );

  const sreMintedRaw: BN = recordData.sreMinted;

  return {
    txSignature: txSig,
    subMinted: kwhWhole.toString(),
    sreMinted: (sreMintedRaw.toNumber() / 1e9).toFixed(9),
  };
}

export interface ReinitResult {
  txSignature: string;
  networkStateAddress: string;
  sreMint: string;
  treasury: string;
  ecosystem: string;
  team: string;
  marketplaceProgram: string;
}

export async function reinitNetworkState(opts?: {
  team?: string;
  marketplaceProgram?: string;
}): Promise<ReinitResult> {
  const [networkStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('network_state')],
    PROGRAM_ID,
  );

  // Read the existing values from the current (old) account
  const info = await connection.getAccountInfo(networkStatePda);
  if (!info) throw new Error('NetworkState PDA not found on-chain');

  const data = info.data;
  if (data.length < 136) {
    throw new Error(`NetworkState account too small to read existing fields: ${data.length} bytes`);
  }

  const sreMint   = new PublicKey(data.slice(40,  72));
  const treasury  = new PublicKey(data.slice(72, 104));
  const ecosystem = new PublicKey(data.slice(104, 136));

  // Use provided values or fall back to sensible defaults
  const team = opts?.team
    ? new PublicKey(opts.team)
    : keypair.publicKey; // authority as stand-in
  const marketplaceProgram = opts?.marketplaceProgram
    ? new PublicKey(opts.marketplaceProgram)
    : SystemProgram.programId;

  console.log('[solana] reinitNetworkState args:', {
    networkState: networkStatePda.toBase58(),
    sreMint: sreMint.toBase58(),
    treasury: treasury.toBase58(),
    ecosystem: ecosystem.toBase58(),
    team: team.toBase58(),
    marketplaceProgram: marketplaceProgram.toBase58(),
    currentSize: data.length,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txSig = await (program as any).methods
    .reinitializeNetworkState(sreMint, treasury, ecosystem, team, marketplaceProgram)
    .accounts({
      authority: keypair.publicKey,
      networkState: networkStatePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await connection.confirmTransaction(txSig, 'confirmed');

  console.log(`[solana] reinitNetworkState confirmed: ${txSig}`);

  // Verify the account is now the correct size
  const updated = await connection.getAccountInfo(networkStatePda);
  console.log(`[solana] NetworkState new size: ${updated?.data.length ?? '?'} bytes`);

  return {
    txSignature: txSig,
    networkStateAddress: networkStatePda.toBase58(),
    sreMint: sreMint.toBase58(),
    treasury: treasury.toBase58(),
    ecosystem: ecosystem.toBase58(),
    team: team.toBase58(),
    marketplaceProgram: marketplaceProgram.toBase58(),
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

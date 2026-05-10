/**
 * Fix SRE token decimals
 *
 * The current SRE mint (4GnQtSzB…) was created with 0 decimals.
 * The energy_registry emission formula treats raw amounts as 9-decimal,
 * so every recording mints ~1 billion times more than intended.
 *
 * This script:
 *   1. Creates a new SRE mint with 9 decimals (no pre-mint)
 *   2. Transfers mint authority → NetworkState PDA
 *   3. Calls reinitializeNetworkState on-chain to swap in the new mint
 *
 * Usage:
 *   npx tsx scripts/fix-sre-decimals.ts
 *
 * Requires SOLANA_PRIVATE_KEY in .env (same key the backend uses).
 */

import '../src/config/env';
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { createMint, setAuthority, AuthorityType } from '@solana/spl-token';
import EnergyRegistryIdl from '../src/abis/energy_registry_solana.json';

const PROGRAM_ID = new PublicKey('E93p3yX6mxswv1yBn6gcZvsPCqckyupUVQKuk6YLNyYR');

async function main() {
  // ── Load keypair ────────────────────────────────────────────────────────────
  const raw = process.env.SOLANA_PRIVATE_KEY?.trim();
  if (!raw) throw new Error('SOLANA_PRIVATE_KEY not set in .env');

  let secretKey: number[];
  try {
    secretKey = JSON.parse(raw);
  } catch {
    secretKey = raw.split(',').map((n) => parseInt(n.trim(), 10));
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  console.log('Deployer :', keypair.publicKey.toBase58());
  console.log('RPC      :', rpcUrl);
  console.log('');

  // ── Derive NetworkState PDA ─────────────────────────────────────────────────
  const [networkStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('network_state')],
    PROGRAM_ID,
  );
  console.log('NetworkState PDA:', networkStatePda.toBase58());

  // ── Read existing on-chain values ───────────────────────────────────────────
  const info = await connection.getAccountInfo(networkStatePda);
  if (!info) throw new Error('NetworkState PDA not found on devnet');

  const d = info.data;
  if (d.length < 136) throw new Error(`NetworkState too small: ${d.length} bytes`);

  const oldSreMint = new PublicKey(d.slice(40, 72));
  const treasury   = new PublicKey(d.slice(72, 104));
  const ecosystem  = new PublicKey(d.slice(104, 136));
  const team       = d.length >= 168
    ? new PublicKey(d.slice(136, 168))
    : new PublicKey(d.slice(8, 40)); // authority fallback for old 137-byte layout

  console.log('Old SRE mint (0 decimals):', oldSreMint.toBase58());
  console.log('Treasury :', treasury.toBase58());
  console.log('Ecosystem:', ecosystem.toBase58());
  console.log('Team     :', team.toBase58());
  console.log('');

  // ── Step 1: create new mint with 9 decimals ─────────────────────────────────
  console.log('Step 1 — Creating new SRE mint (9 decimals, no supply)...');
  const newSreMint = await createMint(
    connection,
    keypair,           // payer
    keypair.publicKey, // mint authority (transferred to PDA in step 2)
    null,              // no freeze authority
    9,
  );
  console.log('  New mint:', newSreMint.toBase58());

  // ── Step 2: hand mint authority to NetworkState PDA ─────────────────────────
  console.log('Step 2 — Transferring mint authority → NetworkState PDA...');
  await setAuthority(
    connection,
    keypair,
    newSreMint,
    keypair.publicKey,
    AuthorityType.MintTokens,
    networkStatePda,
  );
  console.log('  Mint authority is now:', networkStatePda.toBase58());

  // ── Step 3: call reinitializeNetworkState on-chain ──────────────────────────
  console.log('Step 3 — Updating NetworkState to point to new mint...');
  const wallet   = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program  = new anchor.Program(EnergyRegistryIdl as any, provider);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txSig = await (program as any).methods
    .reinitializeNetworkState(
      newSreMint,
      treasury,
      ecosystem,
      team,
      SystemProgram.programId, // marketplace_program placeholder
    )
    .accounts({
      authority: keypair.publicKey,
      networkState: networkStatePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await connection.confirmTransaction(txSig, 'confirmed');
  console.log('  tx:', txSig);

  // ── Verify ──────────────────────────────────────────────────────────────────
  const updated = await connection.getAccountInfo(networkStatePda);
  if (!updated || updated.data.length < 72) throw new Error('Could not verify updated account');
  const storedMint = new PublicKey(updated.data.slice(40, 72));
  const ok = storedMint.toBase58() === newSreMint.toBase58();
  console.log('');
  console.log('Verification:', ok ? 'PASS ✓' : 'FAIL ✗');
  console.log('  NetworkState.sre_mint:', storedMint.toBase58());

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('New SRE mint (9 decimals):', newSreMint.toBase58());
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('Next step: update PROGRAM_IDS.SRE_TOKEN in');
  console.log('  subsidized-energy-solana-dapp/lib/constants.ts');
  console.log('to the address above.');
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

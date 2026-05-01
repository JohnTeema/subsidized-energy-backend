import './config/env';
import app from './app';
import { config } from './config/env';
import { initBlockchain } from './services/blockchainService';
import { initSolanaBlockchain } from './services/solanaBlockchainService';
import { startScheduler } from './services/schedulerService';

async function main() {
  // Initialize blockchain services — but don't crash the server if they fail
  if (config.activeChains.includes('base')) {
    try {
      initBlockchain();
    } catch (err) {
      console.error('[server] Base blockchain init failed:', err);
    }
  }
  if (config.activeChains.includes('solana')) {
    try {
      initSolanaBlockchain();
    } catch (err) {
      console.error('[server] Solana blockchain init failed:', err);
    }
  }

  // Scheduler may depend on blockchain; wrap as well
  try {
    startScheduler();
  } catch (err) {
    console.error('[server] Scheduler init failed:', err);
  }

  app.listen(config.port, () => {
    console.log(`[server] Subsidized Energy API running on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});

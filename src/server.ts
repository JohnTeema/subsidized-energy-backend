import './config/env';
import app from './app';
import { config } from './config/env';
import { initBlockchain } from './services/blockchainService';
import { initSolanaBlockchain } from './services/solanaBlockchainService';
import { startScheduler } from './services/schedulerService';

async function main() {
  if (config.activeChains.includes('base')) {
    initBlockchain();
  }
  if (config.activeChains.includes('solana')) {
    initSolanaBlockchain();
  }
  startScheduler();

  app.listen(config.port, () => {
    console.log(`[server] Subsidized Energy API running on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});

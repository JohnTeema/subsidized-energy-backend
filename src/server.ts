import './config/env';
import app from './app';
import { config } from './config/env';
import { initBlockchain } from './services/blockchainService';
import { startScheduler } from './services/schedulerService';

async function main() {
  initBlockchain();
  startScheduler();

  app.listen(config.port, () => {
    console.log(`[server] Subsidized Energy API running on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});

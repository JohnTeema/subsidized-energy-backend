import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  database: process.env.DATABASE_URL || 'file:./dev.db',

  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
  deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY || '',

  contracts: {
    subToken: process.env.SUB_TOKEN_ADDRESS || '',
    sreToken: process.env.SRE_TOKEN_ADDRESS || '',
    energyRegistry: process.env.ENERGY_REGISTRY_ADDRESS || '',
  },

  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    privateKey: process.env.SOLANA_PRIVATE_KEY || '',
    programId: process.env.SOLANA_ENERGY_REGISTRY || 'E93p3yX6mxswv1yBn6gcZvsPCqckyupUVQKuk6YLNyYR',
  },

  activeChains: (process.env.ACTIVE_CHAINS || 'base,solana').split(',').map(s => s.trim()) as Array<'base' | 'solana'>,
};

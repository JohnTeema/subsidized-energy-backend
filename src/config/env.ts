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
};

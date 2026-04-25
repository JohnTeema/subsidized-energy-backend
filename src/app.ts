import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import inverterRoutes from './routes/inverters';
import energyRoutes from './routes/energy';
import devRoutes from './routes/dev';

const ALLOWED_ORIGINS = [
  'https://subsidized-energy-solana-dapp.vercel.app',
  'https://subsidized-energy-dapp.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
];

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/inverters', inverterRoutes);
app.use('/api/energy', energyRoutes);
app.use('/api/dev', devRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

export default app;

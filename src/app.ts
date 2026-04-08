import express from 'express';
import authRoutes from './routes/auth';
import inverterRoutes from './routes/inverters';
import energyRoutes from './routes/energy';
import devRoutes from './routes/dev';

const app = express();
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/inverters', inverterRoutes);
app.use('/api/energy', energyRoutes);
app.use('/api/dev', devRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

export default app;

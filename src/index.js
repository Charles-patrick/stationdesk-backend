import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { attachUser } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { startScheduler } from './services/scheduler.js';

import auth from './routes/auth.js';
import publicRoutes from './routes/public.js';
import platform from './routes/platform.js';
import station from './routes/station.js';
import users from './routes/users.js';
import catalog from './routes/catalog.js';
import forecourt from './routes/forecourt.js';
import shifts from './routes/shifts.js';
import sales from './routes/sales.js';
import inventory from './routes/inventory.js';
import expenses from './routes/expenses.js';
import orders from './routes/orders.js';
import reports from './routes/reports.js';
import exportsRoute from './routes/exports.js';
import help from './routes/help.js';
import { notifications, auditRouter, approvals } from './routes/misc.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin) || config.nodeEnv !== 'production'),
    credentials: true,
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d' }));
  app.use(attachUser);

  app.get('/api/health', (_req, res) => res.json({ ok: true, name: config.appName }));
  app.use('/api/auth', auth);
  app.use('/api/public', publicRoutes);
  app.use('/api/platform', platform);
  app.use('/api/station', station);
  app.use('/api/users', users);
  app.use('/api/catalog', catalog);
  app.use('/api/forecourt', forecourt);
  app.use('/api/shifts', shifts);
  app.use('/api/sales', sales);
  app.use('/api/inventory', inventory);
  app.use('/api/expenses', expenses);
  app.use('/api/help', help);
  app.use('/api/orders', orders);
  app.use('/api/reports', reports);
  app.use('/api/exports', exportsRoute);
  app.use('/api/notifications', notifications);
  app.use('/api/audit', auditRouter);
  app.use('/api/approvals', approvals);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function main() {
  await migrate();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`${config.appName} API running on port ${config.port}`);
    startScheduler();
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(err); pool.end(); process.exit(1); });
}

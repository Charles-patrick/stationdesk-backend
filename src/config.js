import 'dotenv/config';
import path from 'node:path';

const env = process.env;
export const config = {
  port: Number(env.PORT || 4000),
  nodeEnv: env.NODE_ENV || 'development',
  frontendUrl: env.FRONTEND_URL || 'http://localhost:3000',
  corsOrigins: [env.FRONTEND_URL || 'http://localhost:3000', ...(env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)],
  databaseUrl: env.DATABASE_URL || 'postgres://stationdesk:stationdesk@localhost:5432/stationdesk',
  databaseSsl: env.DATABASE_SSL === 'true',
  jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
  appName: env.APP_NAME || 'StationDesk',
  owner: {
    username: (env.PLATFORM_OWNER_USERNAME || 'owner').toLowerCase(),
    password: env.PLATFORM_OWNER_PASSWORD || 'ChangeMe123!',
    name: env.PLATFORM_OWNER_NAME || 'Platform Owner',
  },
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'StationDesk <no-reply@example.com>',
  },
  uploadDir: path.resolve(env.UPLOAD_DIR || './uploads'),
  publicApiUrl: (env.PUBLIC_API_URL || `http://localhost:${env.PORT || 4000}`).replace(/\/$/, ''),
  seedDemo: env.SEED_DEMO !== 'false',
  enableJobs: env.ENABLE_JOBS !== 'false',
};
if (config.nodeEnv === 'production' && config.jwtSecret === 'dev-secret-change-me') {
  console.warn('WARNING: JWT_SECRET is not set. Set a long random value before going live.');
}

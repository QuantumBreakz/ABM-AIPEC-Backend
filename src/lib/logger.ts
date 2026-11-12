import { pino } from 'pino';
import { env } from '../env.js';

// JSON logs in production (Render shows them), pretty logs locally.
// Cookies and auth headers are never written to logs.
export const log = pino({
  level: env.LOG_LEVEL,
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', 'password', 'passwordHash'],
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});

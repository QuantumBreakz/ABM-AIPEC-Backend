// All configuration comes from environment variables, checked once at boot.
// A missing or bad value stops the server immediately instead of failing later.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGO_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters'),
  SCRAPER_USER_AGENT: z.string().default('SmartLogicsResearchBot/1.0'),
  FETCH_DELAY_MS: z.coerce.number().default(1500),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

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
  // Paid providers: each is OFF unless its key is set (zero-new-cost rule, PTC §8).
  CONTACTOUT_API_KEY: z.string().optional(),
  CONTACTOUT_MAX_LOOKUPS: z.coerce.number().int().min(0).default(50), // hard cap per calendar month
  MILLIONVERIFIER_API_KEY: z.string().optional(),
  MILLIONVERIFIER_MAX_CHECKS: z.coerce.number().int().min(0).default(500), // hard cap per calendar month
  // Claude API key (the AI drafts are written with Anthropic's SDK). Empty = AI off, drafts stay "pending".
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-opus-5-5'),
  LLM_RPM: z.coerce.number().int().min(1).default(20), // max AI requests per minute
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

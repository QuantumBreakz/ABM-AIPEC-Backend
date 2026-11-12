import { defineConfig } from 'vitest/config';

// Tests talk to a real local Mongo + Redis (CI starts them as services).
// Each test file gets its own database, see test/setup.ts.
export default defineConfig({
  test: {
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      MONGO_URL: process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/adipec_test',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      CRON_SECRET: 'test-cron-secret-123',
      FETCH_DELAY_MS: '0',
      LOG_LEVEL: 'silent',
    },
  },
});

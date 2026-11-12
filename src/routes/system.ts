import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import { env } from '../env.js';
import { redisReady } from '../pipeline/queue.js';

export const systemRoutes = Router();

/** Render's health check and GitHub's keep-alive ping hit this. No auth, no secrets in the answer. */
systemRoutes.get('/health', (req, res) => {
  const mongo = mongoose.connection.readyState === 1;
  const redis = redisReady();
  res.status(mongo && redis ? 200 : 503).json({ ok: mongo && redis, mongo, redis, workers: req.app.locals.workers ?? 0 });
});

/**
 * Tasks GitHub Actions can trigger (see .github/workflows/cron.yml). Each one only queues work and returns.
 * Phase 2 adds 'refresh-websites', Phase 5 adds 'verify-emails'.
 */
export const cronTasks: Record<string, () => Promise<unknown>> = {};

const secretOk = (given = '') => {
  const a = Buffer.from(given);
  const b = Buffer.from(env.CRON_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
};

systemRoutes.post('/cron/:task', async (req, res) => {
  if (!secretOk(req.get('x-cron-secret'))) {
    res.status(401).json({ error: { code: 'unauthorized', message: 'Bad cron secret' } });
    return;
  }
  const task = cronTasks[req.params.task];
  if (!task) {
    res.status(404).json({ error: { code: 'not_found', message: `Unknown task ${req.params.task}` } });
    return;
  }
  res.status(202).json({ queued: true, result: await task() });
});

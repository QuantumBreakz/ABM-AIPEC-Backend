/**
 * Boot order: env (checked on import) → Mongo → indexes → workers → rebuild queue from Mongo → HTTP.
 * API and workers share this one process because Render's free plan has no background workers.
 */
import mongoose from 'mongoose';
import { app } from './app.js';
import { env } from './env.js';
import { log } from './lib/logger.js';
import { startPipeline } from './pipeline/index.js';
import { closeQueues } from './pipeline/queue.js';
import { requeueUnfinished } from './pipeline/runs.js';

await mongoose.connect(env.MONGO_URL);
await mongoose.syncIndexes();
const workers = startPipeline();
await requeueUnfinished();

app.locals.workers = workers.length;
const server = app.listen(env.PORT, () => log.info(`API + ${workers.length} workers listening on :${env.PORT}`));

// Render sends SIGTERM on deploy and on sleep. Let running jobs finish so nothing is left half-done.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  server.close();
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

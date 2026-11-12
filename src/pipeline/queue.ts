/**
 * BullMQ plumbing. One queue per pipeline step; a job carries only ids.
 *
 * Render's free Redis is wiped whenever it restarts, so Redis is treated as a to-do list, not a record:
 *  - enqueue() marks the step `in_progress` in Mongo before the job exists in Redis
 *  - on boot, runs.requeueUnfinished() rebuilds the to-do list from Mongo
 * Finished and failed jobs are removed from Redis right away; their outcome is already in Mongo.
 */
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { StepKey } from '../contract.js';
import { setStep } from '../db/helpers.js';
import { STEPS } from '../db/models.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';

export const QUEUES = ['directory', 'profile', 'website', 'emails', 'personalization', 'verification'] as const;
export type QueueName = (typeof QUEUES)[number];
export type JobData = { runId?: string; companyId?: string; contactId?: string };
export type Handler = (job: Job<JobData>) => Promise<void>;

/** Filled in pipeline/index.ts as steps get built. A queue without a handler has no worker. */
export const handlers: Partial<Record<QueueName, Handler>> = {};

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
/** Our Redis keys start with abm: so a Redis shared with other apps can't mix up queues. */
export const PREFIX = 'abm';

const queues = Object.fromEntries(
  QUEUES.map((name) => [
    name,
    new Queue<JobData>(name, {
      connection: redis,
      prefix: PREFIX,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: true },
    }),
  ]),
) as Record<QueueName, Queue<JobData>>;

export const isStep = (name: string): name is StepKey => (STEPS as readonly string[]).includes(name);

/** Same step + same company (or run) = same job id, so queueing twice is a no-op. Ids can't contain ':'. */
export async function enqueue(name: QueueName, data: JobData) {
  if (data.companyId && isStep(name)) await setStep(data.companyId, name, 'in_progress', 'queued');
  const key = data.contactId ?? data.companyId ?? data.runId;
  await queues[name].add(name, data, key ? { jobId: `${name}-${key}` } : {});
}

/** Put a job back after a Redis wipe, without touching its status in Mongo. */
export const requeue = (name: QueueName, data: JobData) =>
  queues[name].add(name, data, { jobId: `${name}-${data.contactId ?? data.companyId ?? data.runId}` });

export type JobHooks = {
  onDone: (queue: QueueName, job: Job<JobData>) => Promise<void>;
  onFinalFailure: (queue: QueueName, job: Job<JobData>, err: Error) => Promise<void>;
};

// ponytail: Render free is 0.1 CPU / 512 MB, so 2 jobs at a time per queue. Raise on a paid plan.
export function startWorkers(hooks: JobHooks) {
  return (Object.entries(handlers) as [QueueName, Handler][]).map(([name, handler]) => {
    const w = new Worker<JobData>(name, handler, { connection: redis, prefix: PREFIX, concurrency: 2 });
    w.on('completed', (job) => hooks.onDone(name, job).catch((e) => log.error({ err: e }, 'onDone hook failed')));
    w.on('failed', (job, err) => {
      if (!job) return;
      const final = err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
      if (final) hooks.onFinalFailure(name, job, err).catch((e) => log.error({ err: e }, 'onFinalFailure hook failed'));
      else log.warn({ queue: name, jobId: job.id, attempt: job.attemptsMade, err: err.message }, 'job failed, will retry');
    });
    w.on('error', (err) => log.error({ err, queue: name }, 'worker error'));
    return w;
  });
}

export const pauseAll = () => Promise.all(Object.values(queues).map((q) => q.pause()));
export const resumeAll = () => Promise.all(Object.values(queues).map((q) => q.resume()));
export const redisReady = () => redis.status === 'ready';

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await redis.quit();
}

/** Tests only: empty every queue. */
export async function drainAll() {
  await Promise.all(Object.values(queues).map((q) => q.obliterate({ force: true })));
}

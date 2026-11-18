/**
 * Zero-Redis-overhead in-process pipeline queue. One queue per step; jobs carry only ids.
 *
 * Since API and workers share one Render process and MongoDB is the durable record:
 *  - enqueue() marks the step `in_progress` in Mongo before adding the job in memory
 *  - on boot, runs.requeueUnfinished() rebuilds any unfinished jobs from Mongo
 *  - Redis (`ioredis`) stays connected only for `/health` readiness checks (0 commands/sec when idle or running).
 */
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { StepKey } from '../contract.js';
import { setStep } from '../db/helpers.js';
import { STEPS } from '../db/models.js';
import { env } from '../env.js';
import { log } from '../lib/logger.js';

export const QUEUES = ['directory', 'profile', 'website', 'emails', 'personalization', 'verification'] as const;
export type QueueName = (typeof QUEUES)[number];
/** `contactId` narrows a job to one contact; `force` re-does work a normal run would skip (e.g. "regenerate"). */
export type JobData = { runId?: string; companyId?: string; contactId?: string; force?: boolean };
export type Handler = (job: Job<JobData>) => Promise<void>;

/** Filled in pipeline/index.ts as steps get built. A queue without a handler has no worker. */
export const handlers: Partial<Record<QueueName, Handler>> = {};

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const PREFIX = 'abm';

export const isStep = (name: string): name is StepKey => (STEPS as readonly string[]).includes(name);

type QueuedItem = { id?: string; data: JobData; attemptsMade: number };

const waiting: Record<QueueName, QueuedItem[]> = {
  directory: [],
  profile: [],
  website: [],
  emails: [],
  personalization: [],
  verification: [],
};
const knownIds: Record<QueueName, Set<string>> = {
  directory: new Set(),
  profile: new Set(),
  website: new Set(),
  emails: new Set(),
  personalization: new Set(),
  verification: new Set(),
};
const activeCount: Record<QueueName, number> = {
  directory: 0,
  profile: 0,
  website: 0,
  emails: 0,
  personalization: 0,
  verification: 0,
};
const retryTimers = new Set<ReturnType<typeof setTimeout>>();

let paused = false;
let workersStarted = false;
let activeHooks: JobHooks | undefined;

// Sliding-window timestamps for `personalization` RPM throttling.
const llmStarts: number[] = [];

async function waitForRpmSlot(): Promise<void> {
  const max = env.LLM_RPM;
  while (true) {
    const now = Date.now();
    while (llmStarts.length && now - llmStarts[0] >= 60_000) llmStarts.shift();
    if (llmStarts.length < max) {
      llmStarts.push(now);
      return;
    }
    const waitMs = Math.max(50, 60_000 - (now - llmStarts[0]) + 10);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function pump(name: QueueName) {
  if (!workersStarted || paused) return;
  const handler = handlers[name];
  if (!handler) return;

  while (activeCount[name] < 2 && waiting[name].length > 0 && !paused) {
    const item = waiting[name].shift()!;
    activeCount[name]++;
    void runItem(name, handler, item);
  }
}

async function runItem(name: QueueName, handler: Handler, item: QueuedItem) {
  const maxAttempts = 3;
  const job = {
    id: item.id,
    name,
    data: item.data,
    attemptsMade: item.attemptsMade,
    opts: { attempts: maxAttempts },
  } as unknown as Job<JobData>;

  try {
    if (name === 'personalization') await waitForRpmSlot();
    await handler(job);
    if (item.id) knownIds[name].delete(item.id);
    await activeHooks?.onDone(name, job).catch((e) => log.error({ err: e }, 'onDone hook failed'));
  } catch (err: any) {
    item.attemptsMade++;
    job.attemptsMade = item.attemptsMade;
    const final = err?.name === 'UnrecoverableError' || item.attemptsMade >= maxAttempts;
    if (final) {
      if (item.id) knownIds[name].delete(item.id);
      await activeHooks?.onFinalFailure(name, job, err).catch((e) => log.error({ err: e }, 'onFinalFailure hook failed'));
    } else {
      const delayMs = env.NODE_ENV === 'test' ? 50 : 30_000 * 2 ** (item.attemptsMade - 1);
      log.warn({ queue: name, jobId: item.id, attempt: item.attemptsMade, err: err?.message }, 'job failed, will retry');
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        waiting[name].push(item);
        pump(name);
      }, delayMs);
      retryTimers.add(timer);
    }
  } finally {
    activeCount[name]--;
    pump(name);
  }
}

function addItem(name: QueueName, data: JobData) {
  const key = data.contactId ?? data.companyId ?? data.runId;
  const id = key ? `${name}-${key}` : undefined;
  if (id) {
    if (knownIds[name].has(id)) return;
    knownIds[name].add(id);
  }
  waiting[name].push({ id, data, attemptsMade: 0 });
  pump(name);
}

/** Same step + same company (or run) = same job id, so queueing twice is a no-op. Ids can't contain ':'. */
export async function enqueue(name: QueueName, data: JobData) {
  if (data.companyId && !data.contactId && isStep(name)) await setStep(data.companyId, name, 'in_progress', 'queued');
  addItem(name, data);
}

/** Queue a follow-up only if that step has been built yet (so later phases switch on by themselves). */
export async function queueIfReady(name: QueueName, data: JobData) {
  if (handlers[name]) await enqueue(name, data);
}

/** Put a job back after a restart, without touching its status in Mongo. */
export async function requeue(name: QueueName, data: JobData) {
  addItem(name, data);
}

export type JobHooks = {
  onDone: (queue: QueueName, job: Job<JobData>) => Promise<void>;
  onFinalFailure: (queue: QueueName, job: Job<JobData>, err: Error) => Promise<void>;
};

export function startWorkers(hooks: JobHooks) {
  activeHooks = hooks;
  workersStarted = true;
  paused = false;
  for (const q of QUEUES) pump(q);
  return Object.keys(handlers).map((name) => ({
    name,
    close: async () => {
      workersStarted = false;
    },
  }));
}

export async function pauseAll() {
  paused = true;
}

export async function resumeAll() {
  paused = false;
  for (const q of QUEUES) pump(q);
}

export const redisReady = () => redis.status === 'ready';

export async function closeQueues() {
  workersStarted = false;
  for (const t of retryTimers) clearTimeout(t);
  retryTimers.clear();
  await redis.quit().catch(() => {});
}

/** Tests only: inspect queued/known job ids for a queue. */
export function getQueuedJobIds(name: QueueName): string[] {
  return [...knownIds[name]];
}

/** Tests only: empty every queue. */
export async function drainAll() {
  for (const t of retryTimers) clearTimeout(t);
  retryTimers.clear();
  for (const q of QUEUES) {
    waiting[q].length = 0;
    knownIds[q].clear();
  }
}

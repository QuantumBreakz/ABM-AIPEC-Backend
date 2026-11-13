/**
 * A run = one pass of the pipeline over an edition. Its numbers are always computed from Mongo,
 * so they stay right even after Redis is wiped.
 */
import type { Job } from 'bullmq';
import type { StepKey, StepStatus } from '../contract.js';
import { setStep } from '../db/helpers.js';
import type { RunSummary } from '../db/mappers.js';
import { Company, Event, Run, type RunDoc } from '../db/models.js';
import { conflict, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { enqueue, handlers, isStep, type JobData, pauseAll, type QueueName, requeue, resumeAll } from './queue.js';
import { afterResearch } from './research.js';

/** What a run can include, in pipeline order. Sales Navigator steps are manual, verification is a separate batch. */
export const RUN_STEPS = ['directory', 'profile', 'website', 'emails', 'personalization'] as const;
export type RunStep = (typeof RUN_STEPS)[number];
/** The per-company chain. `emails` isn't in it: it runs when contacts are added (or when a run asks for it). */
const COMPANY_ORDER: RunStep[] = ['profile', 'website', 'personalization'];

export const activeRun = () => Run.findOne({ status: { $in: ['running', 'paused'] } }).lean();

export async function startRun(edition: number, steps: RunStep[] | undefined, by: string) {
  if (!(await Event.exists({ edition }))) throw notFound(`No event for edition ${edition}. Create it first.`);
  const running = await activeRun();
  if (running) throw conflict('A run is already in progress. Pause or wait for it to finish.', { runId: String(running._id) });

  const chosen = RUN_STEPS.filter((s) => !steps || steps.includes(s));
  const run = await Run.create({ edition, steps: chosen, startedBy: by });
  const runId = String(run._id);

  if (chosen.includes('directory')) {
    await enqueue('directory', { runId });
  } else {
    // Re-running later steps only: start at the first chosen chain step for every company in the edition.
    const first = COMPANY_ORDER.find((s) => chosen.includes(s) && handlers[s]);
    if (first) {
      const ids = await Company.find({ 'editions.edition': edition }, { _id: 1 }).lean();
      for (const { _id } of ids) await enqueue(first, { companyId: String(_id), runId });
    }
    // Email lookup only makes sense where there are contacts.
    if (chosen.includes('emails') && handlers.emails) {
      const ids = await Company.find({ 'editions.edition': edition, contactsCount: { $gt: 0 } }, { _id: 1 }).lean();
      for (const { _id } of ids) await enqueue('emails', { companyId: String(_id), runId });
    }
  }
  await maybeFinishRun(runId);
  return (await Run.findById(runId).lean())!;
}

export async function pauseRun(id: string) {
  const run = await Run.findOneAndUpdate({ _id: id, status: 'running' }, { status: 'paused' }, { returnDocument: 'after' }).lean();
  if (!run) throw conflict('Only a running run can be paused');
  await pauseAll();
  return run;
}

export async function resumeRun(id: string) {
  const run = await Run.findOneAndUpdate({ _id: id, status: 'paused' }, { status: 'running' }, { returnDocument: 'after' }).lean();
  if (!run) throw conflict('Only a paused run can be resumed');
  await resumeAll();
  return run;
}

/**
 * Called when a company finishes a step (success or failure). Runs the follow-ups that always apply,
 * then queues the next step in pipeline order that this run includes and that exists yet.
 */
export async function continueAfter(step: RunStep, companyId: string, runId?: string) {
  if (step === 'website') await afterResearch(companyId); // duplicate check + Sales Navigator hand-off, run or no run
  const run = runId ? await Run.findById(runId, { steps: 1, status: 1 }).lean() : null;
  if (!run || run.status === 'completed' || run.status === 'failed') return;
  // `directory` starts the chain; a step outside the chain (e.g. emails) has nothing after it.
  const i = step === 'directory' ? -1 : COMPANY_ORDER.indexOf(step);
  if (step !== 'directory' && i === -1) return;
  const next = COMPANY_ORDER.slice(i + 1).find((s) => run.steps.includes(s));
  if (next && handlers[next]) await enqueue(next, { companyId, runId });
}

export async function recordRunError(
  runId: string | undefined,
  e: { step: string; message: string; companyId?: string; companyName?: string },
) {
  if (!runId) return;
  await Run.updateOne({ _id: runId }, { $push: { errors: { $each: [{ ...e, at: new Date() }], $slice: -100 } } });
}

/** Done when the directory is done and no company step of this run is still queued or running. */
export async function maybeFinishRun(runId?: string) {
  if (!runId) return;
  const run = await Run.findById(runId).lean();
  if (run?.status !== 'running') return;
  if (run.steps.includes('directory') && !run.directoryDone) return;
  const steps = run.steps.filter(isStep);
  if (steps.length) {
    const busy = await Company.exists({
      'editions.edition': run.edition,
      $or: steps.map((s) => ({ [`stages.${s}.status`]: 'in_progress' })),
    });
    if (busy) return;
  }
  await Run.updateOne({ _id: runId, status: 'running' }, { status: 'completed', finishedAt: new Date() });
  log.info({ runId }, 'run completed');
}

const DONE: StepStatus[] = ['completed', 'partial', 'needs_review', 'pending_access', 'restricted', 'approved'];

/** Counts for the Runs screen, from the current state of every company in the edition. */
export async function summarize(run: RunDoc): Promise<RunSummary> {
  const steps = run.steps.filter(isStep) as StepKey[];
  const companies = await Company.find({ 'editions.edition': run.edition }, { stages: 1 }).lean();
  const status = (c: (typeof companies)[number], s: StepKey): StepStatus => ((c.stages as any)?.[s]?.status ?? 'not_started') as StepStatus;

  const perStep: RunSummary['perStep'] = {};
  if (run.steps.includes('directory'))
    perStep.directory = { queued: run.directoryDone ? 0 : 1, done: run.directoryDone ? 1 : 0, failed: 0 };
  for (const s of steps) {
    const all = companies.map((c) => status(c, s));
    perStep[s] = {
      queued: all.filter((x) => x === 'in_progress').length,
      done: all.filter((x) => DONE.includes(x)).length,
      failed: all.filter((x) => x === 'failed').length,
    };
  }

  const counts = {
    discovered: run.discovered ?? 0,
    attempted: 0,
    completed: 0,
    partial: 0,
    restricted: 0,
    failed: 0,
    duplicate: run.duplicates ?? 0,
  };
  for (const c of companies) {
    const finished = steps.map((s) => status(c, s)).filter((x) => x !== 'not_started' && x !== 'in_progress');
    if (!finished.length) continue;
    counts.attempted++;
    if (finished.includes('failed')) counts.failed++;
    else if (finished.includes('restricted')) counts.restricted++;
    else if (finished.some((x) => x === 'partial' || x === 'needs_review' || x === 'pending_access')) counts.partial++;
    else counts.completed++;
  }
  return { counts, perStep };
}

/** Called by workers after every successful job. */
export async function onDone(_queue: QueueName, job: Job<JobData>) {
  await maybeFinishRun(job.data.runId);
}

/** Called once a job has used up its retries. The company still moves on (PTC §2.1). */
export async function onFinalFailure(queue: QueueName, job: Job<JobData>, err: Error) {
  const { runId, companyId } = job.data;
  log.error({ queue, jobId: job.id, err: err.message }, 'job failed for good');
  if (queue === 'directory') {
    await recordRunError(runId, { step: 'directory', message: err.message });
    await Run.updateOne({ _id: runId }, { status: 'failed', finishedAt: new Date() });
    return;
  }
  if (companyId && isStep(queue)) {
    const company = await Company.findById(companyId, { name: 1 }).lean();
    await setStep(companyId, queue, 'failed', err.message);
    await recordRunError(runId, { step: queue, message: err.message, companyId, companyName: company?.name });
    await continueAfter(queue as RunStep, companyId, runId);
  }
  await maybeFinishRun(runId);
}

/** On boot: rebuild the Redis to-do list from Mongo (Render's free Redis loses everything on restart). */
export async function requeueUnfinished() {
  const run = await activeRun();
  const runId = run ? String(run._id) : undefined;
  let count = 0;
  for (const name of Object.keys(handlers) as QueueName[]) {
    if (!isStep(name)) continue;
    const ids = await Company.find({ [`stages.${name}.status`]: 'in_progress' }, { _id: 1 }).lean();
    for (const { _id } of ids) await requeue(name, { companyId: String(_id), runId });
    count += ids.length;
  }
  if (run?.steps.includes('directory') && !run.directoryDone) {
    await requeue('directory', { runId });
    count++;
  }
  if (run?.status === 'paused') await pauseAll();
  if (count) log.info({ count, runId }, 'requeued unfinished jobs');
}

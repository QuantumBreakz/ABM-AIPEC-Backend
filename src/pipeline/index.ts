// Wire step handlers to their queues, and register the tasks GitHub Actions can trigger.
import { Company, Event } from '../db/models.js';
import { cronTasks } from '../routes/system.js';
import { enqueue, handlers, startWorkers } from './queue.js';
import { activeRun, onDone, onFinalFailure, startRun } from './runs.js';
import { directoryStep } from './steps/directory.js';
import { emailsStep } from './steps/emails.js';
import { personalizationStep } from './steps/personalization.js';
import { profileStep } from './steps/profile.js';
import { verificationStep } from './steps/verification.js';
import { websiteStep } from './steps/website.js';

handlers.directory = directoryStep;
handlers.profile = profileStep;
handlers.website = websiteStep;
handlers.emails = emailsStep;
handlers.personalization = personalizationStep;
handlers.verification = verificationStep;

const DAY = 24 * 60 * 60 * 1000;
const REFRESH_AFTER_DAYS = 30;
const REFRESH_BATCH = 200; // per trigger, so one cron call never floods the queue or other people's websites

/**
 * Weekly (cron.yml): re-read websites last checked more than 30 days ago (FR-11).
 * Reviewer edits survive because the website step skips locked fields.
 */
cronTasks['refresh-websites'] = async () => {
  const cutoff = new Date(Date.now() - REFRESH_AFTER_DAYS * DAY);
  const stale = await Company.find(
    { 'website.url': { $type: 'string' }, 'stages.website.status': { $ne: 'in_progress' }, 'stages.website.updatedAt': { $lt: cutoff } },
    { _id: 1 },
  )
    .sort({ 'stages.website.updatedAt': 1 })
    .limit(REFRESH_BATCH)
    .lean();
  for (const { _id } of stale) await enqueue('website', { companyId: String(_id) });
  return { queued: stale.length };
};

/** Nightly (cron.yml): check every email that hasn't been checked yet, as a run for the latest edition (FR-18). */
cronTasks['verify-emails'] = async () => {
  if (await activeRun()) return { skipped: 'A run is in progress; trying again tomorrow' };
  const event = await Event.findOne({}, { edition: 1 }).sort({ edition: -1 }).lean();
  if (!event) return { skipped: 'No event yet' };
  const run = await startRun(event.edition, ['verification'], 'cron');
  return { runId: String(run._id), status: run.status };
};

export const startPipeline = () => startWorkers({ onDone, onFinalFailure });

// Wire step handlers to their queues, and register the tasks GitHub Actions can trigger.
import { Company } from '../db/models.js';
import { cronTasks } from '../routes/system.js';
import { enqueue, handlers, startWorkers } from './queue.js';
import { onDone, onFinalFailure } from './runs.js';
import { directoryStep } from './steps/directory.js';
import { emailsStep } from './steps/emails.js';
import { profileStep } from './steps/profile.js';
import { websiteStep } from './steps/website.js';

handlers.directory = directoryStep;
handlers.profile = profileStep;
handlers.website = websiteStep;
handlers.emails = emailsStep;
// Phase 4: handlers.personalization = personalizationStep;

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

export const startPipeline = () => startWorkers({ onDone, onFinalFailure });

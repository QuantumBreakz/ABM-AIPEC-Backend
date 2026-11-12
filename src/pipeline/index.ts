// Wire step handlers to their queues. Add a line here as each new step is built.
import { handlers, startWorkers } from './queue.js';
import { onDone, onFinalFailure } from './runs.js';
import { directoryStep } from './steps/directory.js';
import { profileStep } from './steps/profile.js';

handlers.directory = directoryStep;
handlers.profile = profileStep;
// Phase 2: handlers.website = websiteStep;

export const startPipeline = () => startWorkers({ onDone, onFinalFailure });

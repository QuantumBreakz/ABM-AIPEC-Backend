// POST /verification/run (admin): the batch email check after the initial CSV. Shows up as a run.
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../lib/auth.js';
import { startRun } from '../pipeline/runs.js';

export const verificationRoutes = Router();

verificationRoutes.post('/run', requireRole('admin'), async (req, res) => {
  const { edition } = z.object({ edition: z.coerce.number().int({ error: '"edition" must be a year' }) }).parse(req.body);
  const run = await startRun(edition, ['verification'], req.user!.email);
  res.status(202).json({ queued: true, runId: String(run._id) });
});

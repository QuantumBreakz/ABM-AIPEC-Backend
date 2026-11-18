import { Router } from 'express';
import { z } from 'zod';
import { toListItem, toRun } from '../db/mappers.js';
import { Company, Run, type RunDoc } from '../db/models.js';
import { requireRole } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { pauseRun, RUN_STEPS, resumeRun, runCompanyFilter, startRun, summarize } from '../pipeline/runs.js';
import { companyQuery, emailCounts } from './companies.js';
import { paging } from './paging.js';

export const runsRoutes = Router();

const full = async (r: RunDoc) => toRun(r, await summarize(r));

runsRoutes.get('/', async (req, res) => {
  const { page, pageSize, skip } = paging(req.query);
  const [items, total] = await Promise.all([Run.find().sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(), Run.countDocuments()]);
  res.json({ items: await Promise.all(items.map(full)), page, pageSize, total });
});

runsRoutes.post('/', requireRole('admin'), async (req, res) => {
  const body = z
    .object({
      edition: z.number().int(),
      steps: z.array(z.enum(RUN_STEPS)).min(1).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    })
    .parse(req.body);
  const run = await startRun(body.edition, body.steps, req.user!.email, body.limit);
  res.status(202).json(await full(run));
});

runsRoutes.get('/:id', async (req, res) => {
  const run = await Run.findById(req.params.id).lean();
  if (!run) throw notFound('Run not found');
  res.json(await full(run));
});

runsRoutes.get('/:id/companies', async (req, res) => {
  const run = await Run.findById(req.params.id).lean();
  if (!run) throw notFound('Run not found');
  const { page, pageSize, skip } = paging(req.query);
  const { q } = z.object({ q: z.string().trim().max(200).optional() }).parse(req.query);
  const base = runCompanyFilter(run);
  const search = q ? companyQuery({ q, sort: 'name' }) : null;
  const query = search && Object.keys(search).length ? { $and: [base, search] } : base;
  const [docs, total] = await Promise.all([
    Company.find(query).sort({ normalizedName: 1 }).skip(skip).limit(pageSize).lean(),
    Company.countDocuments(query),
  ]);
  const counts = await emailCounts(docs.map((d) => d._id));
  res.json({
    items: docs.map((d) => toListItem(d, counts.get(String(d._id)) ?? {}, run.edition)),
    page,
    pageSize,
    total,
  });
});

runsRoutes.post('/:id/pause', requireRole('admin'), async (req, res) => {
  res.json(await full(await pauseRun(String(req.params.id))));
});

runsRoutes.post('/:id/resume', requireRole('admin'), async (req, res) => {
  res.json(await full(await resumeRun(String(req.params.id))));
});

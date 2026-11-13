import { Router } from 'express';
import { z } from 'zod';
import type { Providers, Suppression as SuppressionT } from '../contract.js';
import { Suppression } from '../db/models.js';
import { env } from '../env.js';
import { requireRole } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';

export const settingsRoutes = Router();
export const suppressionsRoutes = Router(); // admin only (mounted in app.ts)

/** Which paid providers are switched on. "On" only ever means "a key is set" (zero-new-cost rule). */
settingsRoutes.get('/providers', (_req, res) => {
  const hasLlm = !!(env.OPENROUTER_API_KEY || env.LLM_API_KEY);
  const body: Providers = {
    contactout: !!env.CONTACTOUT_API_KEY,
    millionverifier: !!env.MILLIONVERIFIER_API_KEY,
    llm: hasLlm,
    llmModel: hasLlm ? env.LLM_MODEL : undefined,
  };
  res.json(body);
});

const toSuppression = (s: { _id: unknown; value: string; reason?: string | null; at: Date }): SuppressionT => ({
  id: String(s._id),
  value: s.value,
  reason: s.reason ?? undefined,
  at: s.at.toISOString(),
});

suppressionsRoutes.use(requireRole('admin'));

suppressionsRoutes.get('/', async (_req, res) => {
  res.json((await Suppression.find().sort({ at: -1 }).lean()).map(toSuppression));
});

suppressionsRoutes.post('/', async (req, res) => {
  const { value, reason } = z
    .object({
      value: z
        .string()
        .trim()
        .toLowerCase()
        .refine((v) => z.email().safeParse(v).success || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v), 'Must be an email address or a domain'),
      reason: z.string().trim().max(300).optional(),
    })
    .parse(req.body);
  const doc = await Suppression.create({ value, reason });
  res.status(201).json(toSuppression(doc.toObject()));
});

suppressionsRoutes.delete('/:id', async (req, res) => {
  const { deletedCount } = await Suppression.deleteOne({ _id: req.params.id });
  if (!deletedCount) throw notFound('Suppression not found');
  res.sendStatus(204);
});

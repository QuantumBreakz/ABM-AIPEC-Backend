import { Router } from 'express';
import { z } from 'zod';
import { toEvent } from '../db/mappers.js';
import { Event } from '../db/models.js';
import { requireRole } from '../lib/auth.js';

export const eventsRoutes = Router();

eventsRoutes.get('/', async (_req, res) => {
  res.json((await Event.find({}, { categoryPaths: 0 }).sort({ edition: -1 }).lean()).map(toEvent));
});

eventsRoutes.post('/', requireRole('admin'), async (req, res) => {
  const body = z
    .object({
      edition: z.number().int().min(2000).max(2100),
      name: z.string().min(1).max(200),
      directoryUrl: z.url({ protocol: /^https?$/ }),
      advertisedCount: z.number().int().positive().optional(),
    })
    .parse(req.body);
  const event = await Event.create(body);
  res.status(201).json(toEvent(event.toObject()));
});

import { Router } from 'express';
import { z } from 'zod';
import type { AiStatus, EmailStatus, Overview, StepKey, StepStatus } from '../contract.js';
import { AI_STATUSES, Company, Contact, EMAIL_STATUSES, Event, STEPS } from '../db/models.js';
import { notFound } from '../lib/errors.js';

export const statsRoutes = Router();

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

statsRoutes.get('/overview', async (req, res) => {
  const { edition: asked } = z.object({ edition: z.coerce.number().int().optional() }).parse(req.query);
  const event = asked ? await Event.findOne({ edition: asked }).lean() : await Event.findOne().sort({ edition: -1 }).lean();
  if (!event) throw notFound('No event yet. An admin needs to create one.');
  const edition = event.edition;

  const companies = await Company.find(
    { 'editions.edition': edition },
    { stages: 1, editions: 1, duplicateOf: 1, ai: 1, contactsCount: 1 },
  ).lean();
  const ids = companies.map((c) => c._id);

  const byStep = Object.fromEntries(STEPS.map((s) => [s, {}])) as Overview['byStep'];
  let failures = 0;
  const ai = zeros<AiStatus>(AI_STATUSES);
  for (const c of companies) {
    let failed = false;
    for (const s of STEPS) {
      const st = ((c.stages as any)?.[s]?.status ?? 'not_started') as StepStatus;
      byStep[s as StepKey][st] = (byStep[s as StepKey][st] ?? 0) + 1;
      if (st === 'failed') failed = true;
    }
    if (failed) failures++;
    ai[(c.ai?.status ?? 'pending') as AiStatus]++;
  }

  const emailsByStatus = zeros<EmailStatus>(EMAIL_STATUSES);
  const emailRows: { _id: EmailStatus; n: number }[] = await Contact.aggregate([
    { $match: { company: { $in: ids } } },
    { $unwind: '$emails' },
    { $group: { _id: { $ifNull: ['$emails.verification.status', 'not_checked'] }, n: { $sum: 1 } } },
  ]);
  for (const r of emailRows) emailsByStatus[r._id] = r.n;

  const listings = companies.reduce((n, c) => n + c.editions.filter((e) => e.edition === edition).length, 0);
  const flagged = companies.filter((c) => c.duplicateOf).length;

  const body: Overview = {
    edition,
    advertised: event.advertisedCount ?? undefined,
    discovered: listings,
    unique: companies.length - flagged,
    duplicates: listings - companies.length + flagged,
    byStep,
    contacts: await Contact.countDocuments({ company: { $in: ids } }),
    companiesWithContacts: companies.filter((c) => (c.contactsCount ?? 0) > 0).length,
    emailsByStatus,
    ai,
    failures,
  };
  res.json(body);
});

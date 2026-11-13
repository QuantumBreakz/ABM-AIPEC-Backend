/**
 * Overview (dashboard numbers) and the gap report (NFR-08): what was found, researched, contacted,
 * checked and drafted for an edition, and every record that is still blocked, with its reason.
 * Same shapes and rules as the frontend's mock backend.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { AiStatus, EmailStatus, GapReport, Overview, StepKey, StepStatus } from '../contract.js';
import { AI_STATUSES, Company, Contact, EMAIL_STATUSES, Event, STEPS } from '../db/models.js';
import { toCsv } from '../lib/csv.js';
import { notFound } from '../lib/errors.js';

export const statsRoutes = Router(); // mounted at /stats
export const reportsRoutes = Router(); // mounted at /reports

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const statusOf = (c: { stages?: unknown }, s: StepKey) => ((c.stages as any)?.[s]?.status ?? 'not_started') as StepStatus;
const editionQuery = z.object({ edition: z.coerce.number().int({ error: '"edition" must be a year, for example 2026' }).optional() });

/** The asked edition, or the newest one when none is given. */
async function eventFor(query: unknown) {
  const { edition } = editionQuery.parse(query);
  const event = edition ? await Event.findOne({ edition }).lean() : await Event.findOne().sort({ edition: -1 }).lean();
  if (!event) throw notFound(edition ? `No event for edition ${edition}` : 'No event yet. An admin needs to create one.');
  return event;
}

const companiesOf = (edition: number) =>
  Company.find({ 'editions.edition': edition }, { name: 1, stages: 1, editions: 1, duplicateOf: 1, ai: 1, contactsCount: 1 }).lean();

async function overviewFor(
  event: { edition: number; advertisedCount?: number | null },
  companies: Awaited<ReturnType<typeof companiesOf>>,
): Promise<Overview> {
  const { edition } = event;
  const ids = companies.map((c) => c._id);
  const byStep = Object.fromEntries(STEPS.map((s) => [s, {}])) as Overview['byStep'];
  let failures = 0;
  const ai = zeros<AiStatus>(AI_STATUSES);
  for (const c of companies) {
    for (const s of STEPS) byStep[s][statusOf(c, s)] = (byStep[s][statusOf(c, s)] ?? 0) + 1;
    if (STEPS.some((s) => statusOf(c, s) === 'failed')) failures++;
    ai[(c.ai?.status ?? 'pending') as AiStatus]++;
  }

  const emailsByStatus = zeros<EmailStatus>(EMAIL_STATUSES);
  const emailRows: { _id: EmailStatus; n: number }[] = await Contact.aggregate([
    { $match: { company: { $in: ids } } },
    { $unwind: '$emails' },
    { $group: { _id: { $ifNull: ['$emails.verification.status', 'not_checked'] }, n: { $sum: 1 } } },
  ]);
  for (const r of emailRows) emailsByStatus[r._id] = r.n;

  // "Discovered" counts directory listings; a company with two stands is one unique company.
  const listings = companies.reduce((n, c) => n + c.editions.filter((e) => e.edition === edition).length, 0);
  const flagged = companies.filter((c) => c.duplicateOf).length;
  return {
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
}

const BLOCKED: StepStatus[] = ['failed', 'restricted', 'pending_access', 'needs_review'];

async function gapReport(query: unknown): Promise<GapReport> {
  const event = await eventFor(query);
  const companies = await companiesOf(event.edition);
  const o = await overviewFor(event, companies);
  const blocked: GapReport['blocked'] = [];
  for (const c of companies) {
    for (const step of STEPS) {
      const st = (c.stages as any)?.[step] ?? {};
      if (BLOCKED.includes(st.status))
        blocked.push({ companyId: String(c._id), companyName: c.name, step, status: st.status, reason: st.reason ?? undefined });
    }
  }
  return {
    edition: event.edition,
    generatedAt: new Date().toISOString(),
    advertised: o.advertised,
    discovered: o.discovered,
    researched: companies.filter((c) => ['completed', 'partial', 'approved'].includes(statusOf(c, 'website'))).length,
    contactsFound: o.contacts,
    emailsChecked: Object.entries(o.emailsByStatus).reduce((n, [k, v]) => (k === 'not_checked' ? n : n + v), 0),
    aiDone: companies.filter((c) => c.ai?.status === 'draft' || c.ai?.status === 'approved').length,
    byStep: o.byStep,
    blocked,
  };
}

statsRoutes.get('/overview', async (req, res) => {
  const event = await eventFor(req.query);
  res.json(await overviewFor(event, await companiesOf(event.edition)));
});

reportsRoutes.get('/gap', async (req, res) => {
  res.json(await gapReport(req.query));
});

reportsRoutes.get('/gap.csv', async (req, res) => {
  const r = await gapReport(req.query);
  const rows = [
    ['Company ID', 'Company', 'Step', 'Status', 'Reason'],
    ...r.blocked.map((b) => [b.companyId, b.companyName, b.step, b.status, b.reason]),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gap-report-${r.edition}.csv"`);
  res.send(toCsv(rows));
});

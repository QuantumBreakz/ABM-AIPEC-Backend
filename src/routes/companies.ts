import { Router } from 'express';
import { z } from 'zod';
import type { CompanyListItem, HistoryEntry } from '../contract.js';
import { saveWithHistory, setStep } from '../db/helpers.js';
import { toCompany, toListItem } from '../db/mappers.js';
import { AI_STATUSES, CONFIDENCE, COVERAGE, Company, Contact, EMAIL_STATUSES, History, STATUSES, STEPS } from '../db/models.js';
import { requireRole } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { normalizeDomain, normalizeName } from '../lib/normalize.js';
import { queueIfReady } from '../pipeline/queue.js';
import { markNotDuplicate, mergeCompanies } from '../pipeline/research.js';
import { paging } from './paging.js';

export const companiesRoutes = Router();

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** CompanyFilters from the contract. Also used later by exports, so the list and the CSV always agree. */
export const companyFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  edition: z.coerce.number().int().optional(),
  category: z.string().trim().max(200).optional(),
  country: z.string().trim().max(200).optional(),
  step: z.enum(STEPS).optional(),
  stepStatus: z.enum(STATUSES).optional(),
  hasContacts: bool.optional(),
  emailStatus: z.enum(EMAIL_STATUSES).optional(),
  aiStatus: z.enum(AI_STATUSES).optional(),
  duplicate: bool.optional(),
  sort: z.enum(['name', '-name', 'updatedAt', '-updatedAt', 'completeness', '-completeness']).default('name'),
});
export type CompanyFilters = z.infer<typeof companyFiltersSchema>;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const contains = (s: string) => new RegExp(escapeRegex(s), 'i');

// Plain object: Mongoose's typed filters can't express these dynamic paths.
type Filter = Record<string, any>;

export function companyQuery(f: CompanyFilters): Filter {
  const and: Filter[] = [];
  if (f.q) {
    const n = normalizeName(f.q);
    and.push({
      $or: [
        { name: contains(f.q) },
        { originalNames: contains(f.q) }, // spellings from other listings
        ...(n ? [{ normalizedName: contains(n) }] : []),
        { domain: contains(f.q.toLowerCase()) },
      ],
    });
  }
  // Edition, category and country must match on the same listing.
  const listing: Record<string, unknown> = {};
  if (f.edition) listing.edition = f.edition;
  if (f.category) listing.category = contains(f.category);
  if (f.country) listing.country = new RegExp(`^${escapeRegex(f.country)}$`, 'i'); // exact country, any case
  if (Object.keys(listing).length) and.push({ editions: { $elemMatch: listing } });

  if (f.step && f.stepStatus) and.push({ [`stages.${f.step}.status`]: f.stepStatus });
  else if (f.stepStatus) and.push({ $or: STEPS.map((s) => ({ [`stages.${s}.status`]: f.stepStatus })) });
  if (f.hasContacts !== undefined) and.push(f.hasContacts ? { contactsCount: { $gt: 0 } } : { contactsCount: 0 });
  if (f.emailStatus) and.push({ emailStatuses: f.emailStatus });
  if (f.aiStatus) and.push({ 'ai.status': f.aiStatus });
  if (f.duplicate !== undefined) and.push({ duplicateOf: { $exists: f.duplicate } });
  return and.length ? { $and: and } : {};
}

const SORT: Record<string, Record<string, 1 | -1>> = {
  name: { normalizedName: 1 },
  '-name': { normalizedName: -1 },
  updatedAt: { updatedAt: 1 },
  '-updatedAt': { updatedAt: -1 },
  completeness: { completeness: 1, normalizedName: 1 },
  '-completeness': { completeness: -1, normalizedName: 1 },
};

/** Email status counts per company, for one page of the list, in a single query. */
async function emailCounts(ids: unknown[]) {
  const rows: { _id: { c: unknown; s: string }; n: number }[] = await Contact.aggregate([
    { $match: { company: { $in: ids } } },
    { $unwind: '$emails' },
    { $group: { _id: { c: '$company', s: { $ifNull: ['$emails.verification.status', 'not_checked'] } }, n: { $sum: 1 } } },
  ]);
  const out = new Map<string, CompanyListItem['emailsByStatus']>();
  for (const r of rows) {
    const m = out.get(String(r._id.c)) ?? {};
    m[r._id.s as keyof typeof m] = r.n;
    out.set(String(r._id.c), m);
  }
  return out;
}

companiesRoutes.get('/', async (req, res) => {
  const { page, pageSize, skip } = paging(req.query);
  const filters = companyFiltersSchema.parse(req.query);
  const query = companyQuery(filters);
  const [docs, total] = await Promise.all([
    Company.find(query).sort(SORT[filters.sort]).skip(skip).limit(pageSize).lean(),
    Company.countDocuments(query),
  ]);
  const counts = await emailCounts(docs.map((d) => d._id));
  res.json({ items: docs.map((d) => toListItem(d, counts.get(String(d._id)) ?? {}, filters.edition)), page, pageSize, total });
});

companiesRoutes.get('/:id', async (req, res) => {
  const doc = await Company.findById(req.params.id).lean();
  if (!doc) throw notFound('Company not found');
  const contacts = await Contact.find({ company: doc._id }).sort({ lastName: 1 }).lean();
  res.json(toCompany(doc, contacts));
});

// ---------------------------------------------------------------------------------------------
// Edits by reviewers (BE-2.4). Every change goes through saveWithHistory: old value kept, field locked.
// ---------------------------------------------------------------------------------------------

const httpUrl = z.url({ protocol: /^https?$/, error: 'Enter a full web address starting with http:// or https://' }).max(500);
/** "" or null clears the field (same as the frontend sends from an emptied input). */
const clearable = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === '' ? null : v), t.nullable());

/** The fields a person may edit (contract: PATCH /companies/:id). Nested or dotted keys both work. */
const editSchema = z
  .object({
    'website.url': clearable(httpUrl),
    'website.summary': clearable(z.string().trim().max(2000)),
    'website.services': z.array(z.string().trim().min(1).max(200)).max(100),
    'website.markets': z.array(z.string().trim().min(1).max(200)).max(100),
    'socials.linkedin': clearable(httpUrl),
    'socials.facebook': clearable(httpUrl),
    'socials.instagram': clearable(httpUrl),
    'socials.x': clearable(httpUrl),
    'socials.youtube': clearable(httpUrl),
    'socials.other': z.array(httpUrl).max(20),
    'salesNav.accountUrl': clearable(httpUrl),
    'salesNav.matchConfidence': clearable(z.enum(CONFIDENCE)),
    leadershipCoverage: z.preprocess((v) => (v === '' || v === null ? 'unknown' : v), z.enum(COVERAGE)),
  })
  .partial()
  .strict();

/** { website: { url } } → { "website.url": … }. Arrays and nulls are values, not objects to walk into. */
function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

async function companyResponse(id: string) {
  const doc = await Company.findById(id).lean();
  if (!doc) throw notFound('Company not found');
  return toCompany(doc, await Contact.find({ company: doc._id }).sort({ lastName: 1 }).lean());
}

companiesRoutes.patch('/:id', async (req, res) => {
  const changes = editSchema.parse(flatten(req.body)) as Record<string, unknown>;
  if (!Object.keys(changes).length) throw badRequest('Nothing to change');
  const company = await Company.findById(req.params.id, { domain: 1, website: 1 }).lean();
  if (!company) throw notFound('Company not found');

  // A new website also means a new domain (which must not belong to another company), and fresh research.
  const newSite = 'website.url' in changes && changes['website.url'] !== company.website?.url;
  if (newSite) {
    const domain = normalizeDomain(changes['website.url'] as string | null) ?? null;
    if (domain) {
      const other = await Company.findOne({ domain, _id: { $ne: company._id } }, { name: 1 }).lean();
      if (other)
        throw conflict(`That website’s domain is already on “${other.name}”. Merge the two instead.`, { companyId: String(other._id) });
    }
    changes.domain = domain;
  }
  await saveWithHistory(Company, company._id, changes, req.user!.email);
  if (newSite && changes['website.url']) await queueIfReady('website', { companyId: String(company._id) });
  res.json(await companyResponse(String(company._id)));
});

/** A reviewer sets a step's status by hand (e.g. "Sales Navigator done"). Logged, not locked. */
companiesRoutes.post('/:id/steps/:step', async (req, res) => {
  const step = z.enum(STEPS).parse(req.params.step);
  const body = z
    .object({
      status: z.enum(STATUSES).exclude(['in_progress']), // only the system queues work
      reason: z.string().trim().min(1, 'Say why, in a few words').max(500),
    })
    .parse(req.body);
  const company = await Company.findById(req.params.id, { contactsCount: 1, stages: 1 }).lean();
  if (!company) throw notFound('Company not found');
  // Logged as status → status, and not locked: a later run may update this step again.
  const before = (company.stages as any)?.[step]?.status ?? 'not_started';
  await setStep(company._id, step, body.status, body.reason);
  await History.create({
    entity: 'Company',
    entityId: company._id,
    field: `stages.${step}`,
    before,
    after: body.status,
    by: req.user!.email,
  });
  // People done and contacts present → look up their emails.
  if (step === 'people' && ['completed', 'approved'].includes(body.status) && company.contactsCount > 0) {
    await queueIfReady('emails', { companyId: String(company._id) });
  }
  res.json(await companyResponse(String(company._id)));
});

companiesRoutes.post('/:id/merge', async (req, res) => {
  const { intoId } = z.object({ intoId: z.string().regex(/^[a-f0-9]{24}$/i, 'Not a company id') }).parse(req.body);
  res.json(await companyResponse(await mergeCompanies(String(req.params.id), intoId, req.user!.email)));
});

companiesRoutes.post('/:id/not-duplicate', async (req, res) => {
  await markNotDuplicate(String(req.params.id), req.user!.email);
  res.json(await companyResponse(String(req.params.id)));
});

/** The company's timeline, newest first. Contact changes appear as `contact:<id>` entries. */
companiesRoutes.get('/:id/history', async (req, res) => {
  const company = await Company.findById(req.params.id, { _id: 1 }).lean();
  if (!company) throw notFound('Company not found');
  const rows = await History.find({ entity: 'Company', entityId: company._id }).sort({ at: -1 }).limit(500).lean();
  const body: HistoryEntry[] = rows.map((h) => ({
    field: h.field ?? '',
    before: h.before,
    after: h.after,
    by: h.by,
    at: h.at.toISOString(),
  }));
  res.json(body);
});

/** Admin only. Removes the company and its contacts; history keeps only that it happened (no personal data). */
companiesRoutes.delete('/:id', requireRole('admin'), async (req, res) => {
  const company = await Company.findById(req.params.id, { name: 1 }).lean();
  if (!company) throw notFound('Company not found');
  const { deletedCount } = await Contact.deleteMany({ company: company._id });
  await History.create({
    entity: 'Company',
    entityId: company._id,
    field: '_deleted',
    before: { name: company.name, contacts: deletedCount },
    by: req.user!.email,
  });
  await Company.deleteOne({ _id: company._id });
  await Company.updateMany({ duplicateOf: company._id }, { $unset: { duplicateOf: 1, duplicateReason: 1 } });
  res.sendStatus(204);
});

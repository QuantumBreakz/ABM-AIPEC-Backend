import { Router } from 'express';
import { z } from 'zod';
import type { CompanyListItem } from '../contract.js';
import { toCompany, toListItem } from '../db/mappers.js';
import { AI_STATUSES, Company, Contact, EMAIL_STATUSES, STATUSES, STEPS } from '../db/models.js';
import { notFound } from '../lib/errors.js';
import { normalizeName } from '../lib/normalize.js';
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
    and.push({ $or: [{ name: contains(f.q) }, ...(n ? [{ normalizedName: contains(n) }] : []), { domain: contains(f.q.toLowerCase()) }] });
  }
  // Edition, category and country must match on the same listing.
  const listing: Record<string, unknown> = {};
  if (f.edition) listing.edition = f.edition;
  if (f.category) listing.category = contains(f.category);
  if (f.country) listing.country = contains(f.country);
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

/**
 * Review queue (BE-2.5). Nothing is stored separately: each list is a live query over companies,
 * so an item disappears the moment the underlying issue is fixed.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ReviewItem, ReviewType } from '../contract.js';
import { Company, type CompanyDoc } from '../db/models.js';
import { paging } from './paging.js';

export const reviewRoutes = Router();

const OPEN = ['pending_access', 'needs_review'];
const stage = (c: CompanyDoc, s: string) => (c.stages as any)?.[s] ?? {};

type Def = { filter: Record<string, unknown>; reason: (c: CompanyDoc) => string; since: (c: CompanyDoc) => Date | undefined };

const TYPES: Record<ReviewType, Def> = {
  website: {
    // Restricted sites too: a person can read the site in a browser and fill in the summary by hand.
    filter: { 'stages.website.status': { $in: ['needs_review', 'restricted'] } },
    reason: (c) => stage(c, 'website').reason ?? 'Website needs a look',
    since: (c) => stage(c, 'website').updatedAt,
  },
  duplicate: {
    filter: { duplicateOf: { $exists: true } },
    reason: (c) => c.duplicateReason ?? 'Possible duplicate',
    since: (c) => c.updatedAt,
  },
  salesnav: {
    filter: { $or: [{ 'stages.account.status': { $in: OPEN } }, { 'stages.people.status': { $in: OPEN } }] },
    reason: (c) => stage(c, 'account').reason ?? stage(c, 'people').reason ?? 'Waiting for Sales Navigator review',
    since: (c) => stage(c, 'account').updatedAt ?? stage(c, 'people').updatedAt,
  },
  contacts: {
    filter: { 'stages.people.status': { $in: ['completed', 'approved'] }, contactsCount: 0 },
    reason: () => 'People step is done but no contacts were added',
    since: (c) => stage(c, 'people').updatedAt,
  },
  emails: {
    filter: {
      contactsCount: { $gt: 0 },
      $or: [{ emailStatuses: { $in: ['invalid', 'risky'] } }, { 'stages.emails.status': { $in: [...OPEN, 'partial'] } }],
    },
    reason: (c) => stage(c, 'emails').reason ?? 'Some emails are invalid or risky',
    since: (c) => stage(c, 'emails').updatedAt ?? c.updatedAt,
  },
  ai: {
    filter: { 'ai.status': { $in: ['insufficient_evidence', 'rejected'] } },
    reason: (c) => c.ai?.reason ?? (c.ai?.status === 'rejected' ? 'Draft was rejected' : 'Not enough sourced facts'),
    since: (c) => c.updatedAt,
  },
};
const REVIEW_TYPES = Object.keys(TYPES) as ReviewType[];

const withEdition = (filter: Record<string, unknown>, edition?: number) => (edition ? { ...filter, 'editions.edition': edition } : filter);
const editionQuery = z.object({ edition: z.coerce.number().int().optional() });

reviewRoutes.get('/counts', async (req, res) => {
  const { edition } = editionQuery.parse(req.query);
  const counts = await Promise.all(REVIEW_TYPES.map((t) => Company.countDocuments(withEdition(TYPES[t].filter, edition))));
  res.json(Object.fromEntries(REVIEW_TYPES.map((t, i) => [t, counts[i]])));
});

reviewRoutes.get('/', async (req, res) => {
  const { type, edition } = editionQuery.extend({ type: z.enum(REVIEW_TYPES) }).parse(req.query);
  const { page, pageSize, skip } = paging(req.query);
  const def = TYPES[type];
  const filter = withEdition(def.filter, edition);
  const [docs, total] = await Promise.all([
    Company.find(filter).sort({ updatedAt: 1 }).skip(skip).limit(pageSize).lean(), // oldest first
    Company.countDocuments(filter),
  ]);
  const items: ReviewItem[] = docs.map((c) => ({
    type,
    companyId: String(c._id),
    companyName: c.name,
    reason: def.reason(c),
    since: (def.since(c) ?? c.updatedAt).toISOString(),
  }));
  res.json({ items, page, pageSize, total });
});

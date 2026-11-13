/**
 * Review queue (BE-2.5). Nothing is stored separately: every list is worked out from the data, so fixing
 * the underlying issue (editing a field, merging, adding a contact, approving a draft…) removes the item by itself.
 * Same rules as the frontend's mock backend. Newest first.
 *
 *  website    website step needs_review, failed or restricted (a person can fill in what we couldn't read)
 *  duplicate  flagged as a possible duplicate
 *  salesnav   account step waiting (pending_access / needs_review), unless the company is a flagged duplicate
 *  contacts   people step needs_review / partial and no contacts yet
 *  emails     one item per email whose check came back invalid, risky or unknown
 *  ai         company or contact draft with insufficient evidence, or rejected
 */
import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import type { AiStatus, ReviewItem, ReviewType } from '../contract.js';
import { Company, Contact } from '../db/models.js';
import { paging } from './paging.js';

export const reviewRoutes = Router();

const REVIEW_TYPES = ['website', 'duplicate', 'salesnav', 'contacts', 'emails', 'ai'] as const satisfies readonly ReviewType[];
const OPEN = ['pending_access', 'needs_review'];
const BAD_EMAIL = ['invalid', 'risky', 'unknown'];
const AI_ATTENTION: AiStatus[] = ['insufficient_evidence', 'rejected'];

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : new Date(0).toISOString());
const stage = (c: { stages?: unknown }, s: string) =>
  ((c.stages as any)?.[s] ?? {}) as { status?: string; reason?: string; updatedAt?: Date };
const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`;

/** Company names (and edition check) for items that start from contacts. */
async function companiesById(ids: Types.ObjectId[], edition?: number) {
  const filter: Record<string, unknown> = { _id: { $in: ids } };
  if (edition) filter['editions.edition'] = edition;
  const docs = await Company.find(filter, { name: 1 }).lean();
  return new Map(docs.map((c) => [String(c._id), c.name]));
}

async function itemsFor(type: ReviewType, edition?: number): Promise<ReviewItem[]> {
  const inEdition: Record<string, unknown> = edition ? { 'editions.edition': edition } : {};
  const base = (c: { _id: unknown; name: string }) => ({ type, companyId: String(c._id), companyName: c.name });

  switch (type) {
    case 'website': {
      const docs = await Company.find(
        { ...inEdition, 'stages.website.status': { $in: ['needs_review', 'failed', 'restricted'] } },
        { name: 1, stages: 1, updatedAt: 1 },
      ).lean();
      return docs.map((c) => ({
        ...base(c),
        reason: stage(c, 'website').reason ?? 'Website needs a person to check it.',
        since: iso(stage(c, 'website').updatedAt ?? c.updatedAt),
      }));
    }
    case 'duplicate': {
      const docs = await Company.find(
        { ...inEdition, duplicateOf: { $exists: true, $ne: null } },
        { name: 1, duplicateOf: 1, duplicateReason: 1, updatedAt: 1 },
      ).lean();
      const names = await companiesById(docs.map((c) => c.duplicateOf!));
      return docs.map((c) => ({
        ...base(c),
        reason: c.duplicateReason ?? `Possible duplicate of ${names.get(String(c.duplicateOf)) ?? String(c.duplicateOf)}.`,
        since: iso(c.updatedAt),
      }));
    }
    case 'salesnav': {
      const docs = await Company.find(
        { ...inEdition, duplicateOf: { $in: [null] }, 'stages.account.status': { $in: OPEN } },
        { name: 1, stages: 1, updatedAt: 1 },
      ).lean();
      return docs.map((c) => ({
        ...base(c),
        reason: stage(c, 'account').reason ?? 'Find this company in Sales Navigator.',
        since: iso(stage(c, 'account').updatedAt ?? c.updatedAt),
      }));
    }
    case 'contacts': {
      const docs = await Company.find(
        { ...inEdition, contactsCount: 0, 'stages.people.status': { $in: ['needs_review', 'partial'] } },
        { name: 1, stages: 1, updatedAt: 1 },
      ).lean();
      return docs.map((c) => ({
        ...base(c),
        reason: stage(c, 'people').reason ?? 'No contacts found yet.',
        since: iso(stage(c, 'people').updatedAt ?? c.updatedAt),
      }));
    }
    case 'emails': {
      const people = await Contact.find(
        { 'emails.verification.status': { $in: BAD_EMAIL } },
        { company: 1, firstName: 1, lastName: 1, emails: 1 },
      ).lean();
      const names = await companiesById(
        people.map((p) => p.company),
        edition,
      );
      return people.flatMap((p) =>
        names.has(String(p.company))
          ? p.emails
              .filter((e) => BAD_EMAIL.includes(e.verification?.status ?? 'not_checked'))
              .map((e) => ({
                type,
                companyId: String(p.company),
                companyName: names.get(String(p.company))!,
                contactId: String(p._id),
                contactName: fullName(p),
                reason: `${e.address} is ${e.verification!.status}.`,
                since: iso(e.verification?.checkedAt ?? e.capturedAt),
              }))
          : [],
      );
    }
    case 'ai': {
      const docs = await Company.find({ ...inEdition, 'ai.status': { $in: AI_ATTENTION } }, { name: 1, ai: 1, updatedAt: 1 }).lean();
      const people = await Contact.find(
        { 'ai.status': { $in: AI_ATTENTION } },
        { company: 1, firstName: 1, lastName: 1, ai: 1, updatedAt: 1 },
      ).lean();
      const names = await companiesById(
        people.map((p) => p.company),
        edition,
      );
      return [
        ...docs.map((c) => ({ ...base(c), reason: c.ai?.reason ?? 'Company draft needs attention.', since: iso(c.updatedAt) })),
        ...people
          .filter((p) => names.has(String(p.company)))
          .map((p) => ({
            type,
            companyId: String(p.company),
            companyName: names.get(String(p.company))!,
            contactId: String(p._id),
            contactName: fullName(p),
            reason: p.ai?.reason ?? 'Contact draft needs attention.',
            since: iso(p.updatedAt),
          })),
      ];
    }
  }
}

const newestFirst = (items: ReviewItem[]) => items.sort((a, b) => b.since.localeCompare(a.since));
const editionQuery = z.object({ edition: z.coerce.number().int().optional() });

reviewRoutes.get('/counts', async (req, res) => {
  const { edition } = editionQuery.parse(req.query);
  const lists = await Promise.all(REVIEW_TYPES.map((t) => itemsFor(t, edition)));
  res.json(Object.fromEntries(REVIEW_TYPES.map((t, i) => [t, lists[i].length])));
});

// ponytail: builds the whole list for one type, then pages it in memory. Fine for a few thousand items;
// move to an aggregation with $facet if a queue ever grows past ~10k.
reviewRoutes.get('/', async (req, res) => {
  const { type, edition } = editionQuery
    .extend({ type: z.enum(REVIEW_TYPES, { error: `"type" must be one of: ${REVIEW_TYPES.join(', ')}` }) })
    .parse(req.query);
  const { page, pageSize, skip } = paging(req.query);
  const all = newestFirst(await itemsFor(type, edition));
  res.json({ items: all.slice(skip, skip + pageSize), page, pageSize, total: all.length });
});

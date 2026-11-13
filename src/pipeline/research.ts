/**
 * What happens once a company's research is done, plus the duplicate tools reviewers use.
 *
 *  - checkDuplicates: flag (never auto-merge) a likely duplicate: same website domain, or a near-identical name.
 *    Exact same names were already merged by the directory step. A person decides the rest (FR-10).
 *  - salesNavHandoff: put the company in the Sales Navigator review queue. The system never opens LinkedIn (NFR-07).
 *  - mergeCompanies / markNotDuplicate: the two answers a reviewer can give.
 */
import type { Types } from 'mongoose';
import { completenessOf, refreshContactStats } from '../db/helpers.js';
import { Company, type CompanyDoc, Contact, History } from '../db/models.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { nameSimilarity, normalizeDomain } from '../lib/normalize.js';

// Words too common to find name look-alikes with.
const COMMON = new Set(
  'energy oil gas services service international group engineering industries industrial global middle east national general trading solutions technologies technology company petroleum systems abu dhabi dubai emirates saudi arabia gulf arabian equipment offshore marine'.split(
    ' ',
  ),
);
const SIMILAR = 0.75;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function afterResearch(companyId: string) {
  await checkDuplicates(companyId);
  await salesNavHandoff(companyId);
}

export async function checkDuplicates(companyId: string) {
  const c = await Company.findById(companyId).lean();
  if (!c || c.duplicateOf) return;
  const ignore = new Set([String(c._id), ...(c.notDuplicateOf ?? []).map(String)]);
  const ok = (o: Pick<CompanyDoc, '_id' | 'notDuplicateOf'>) =>
    !ignore.has(String(o._id)) && !(o.notDuplicateOf ?? []).some((x) => String(x) === String(c._id));

  let match: { id: Types.ObjectId; reason: string } | undefined;

  const domain = c.domain ?? normalizeDomain(c.website?.url);
  if (domain) {
    const others = await Company.find({ _id: { $ne: c._id }, domain }, { name: 1, notDuplicateOf: 1 }).lean();
    const o = others.find(ok);
    if (o) match = { id: o._id, reason: `Same website domain (${domain}) as “${o.name}”` };
  }

  if (!match) {
    const key = c.normalizedName
      .split(' ')
      .filter((w) => w.length >= 4 && !COMMON.has(w))
      .sort((a, b) => b.length - a.length)[0];
    if (key) {
      const others = await Company.find(
        { _id: { $ne: c._id }, normalizedName: new RegExp(`\\b${escapeRegex(key)}\\b`) },
        { name: 1, notDuplicateOf: 1 },
      )
        .limit(50)
        .lean();
      const best = others
        .filter(ok)
        .map((o) => ({ o, score: nameSimilarity(c.name, o.name) }))
        .filter((x) => x.score >= SIMILAR)
        .sort((a, b) => b.score - a.score)[0];
      if (best) match = { id: best.o._id, reason: `Name is very similar to “${best.o.name}”` };
    }
  }

  if (match) await Company.updateOne({ _id: c._id }, { $set: { duplicateOf: match.id, duplicateReason: match.reason } });
}

/** Account + people start as "waiting for a person". Never touches a step someone already worked on. */
export async function salesNavHandoff(companyId: string) {
  const state = { status: 'pending_access', reason: 'Waiting for Sales Navigator review', updatedAt: new Date() };
  for (const step of ['account', 'people'] as const) {
    await Company.updateOne(
      { _id: companyId, [`stages.${step}.status`]: { $in: ['not_started', null] } },
      { $set: { [`stages.${step}`]: state } },
    );
  }
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const get = (obj: any, path: string) => path.split('.').reduce((o, k) => o?.[k], obj);
const FILLABLE = [
  'website.url',
  'website.summary',
  'website.services',
  'website.markets',
  'website.facts',
  'website.pagesReviewed',
  'website.contactDetails',
  'socials.linkedin',
  'socials.facebook',
  'socials.instagram',
  'socials.x',
  'socials.youtube',
  'salesNav.accountUrl',
  'salesNav.matchConfidence',
];

/**
 * Fold `fromId` into `intoId`: keep every listing, contact and fact; fill gaps on the kept record;
 * point other duplicate flags at the kept one; record it in history; delete the merged record.
 */
export async function mergeCompanies(fromId: string, intoId: string, by: string) {
  if (fromId === intoId) throw badRequest('A company can’t be merged into itself');
  const [from, into] = await Promise.all([Company.findById(fromId).lean(), Company.findById(intoId).lean()]);
  if (!from || !into) throw notFound('Company not found');

  const listingKey = (e: { edition: number; sourceId: string }) => `${e.edition}-${e.sourceId}`;
  const have = new Set(into.editions.map(listingKey));
  const set: Record<string, unknown> = {
    editions: [...into.editions, ...from.editions.filter((e) => !have.has(listingKey(e)))],
    originalNames: [...new Set([...(into.originalNames ?? []), ...(from.originalNames ?? [])])],
    lockedFields: [...new Set([...(into.lockedFields ?? []), ...(from.lockedFields ?? [])])],
    notDuplicateOf: [...(into.notDuplicateOf ?? []), ...(from.notDuplicateOf ?? [])].filter((x) => String(x) !== String(into._id)),
  };
  for (const path of FILLABLE) if (isEmpty(get(into, path)) && !isEmpty(get(from, path))) set[path] = get(from, path);
  if (into.leadershipCoverage === 'unknown' && from.leadershipCoverage !== 'unknown') set.leadershipCoverage = from.leadershipCoverage;

  // A domain is unique, so free it on the merged record before moving it over.
  if (!into.domain && from.domain) {
    await Company.updateOne({ _id: from._id }, { $unset: { domain: 1 } });
    set.domain = from.domain;
  }
  const unset: Record<string, 1> = {};
  if (String(into.duplicateOf) === String(from._id)) Object.assign(unset, { duplicateOf: 1, duplicateReason: 1 });
  await Company.updateOne({ _id: into._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });

  // Contacts move over. The same person on both records is merged into one, keeping all emails.
  for (const ct of await Contact.find({ company: from._id }).lean()) {
    const twin = ct.profileUrl ? await Contact.findOne({ company: into._id, profileUrl: ct.profileUrl }).lean() : null;
    if (!twin) {
      await Contact.updateOne({ _id: ct._id }, { $set: { company: into._id } });
      continue;
    }
    const known = new Set(twin.emails.map((e) => e.address));
    await Contact.updateOne({ _id: twin._id }, { $push: { emails: { $each: ct.emails.filter((e) => !known.has(e.address)) } } });
    await Contact.deleteOne({ _id: ct._id });
  }

  await Company.updateMany({ duplicateOf: from._id }, { $set: { duplicateOf: into._id } });
  await Company.updateOne({ _id: into._id, duplicateOf: into._id }, { $unset: { duplicateOf: 1, duplicateReason: 1 } });
  await History.create({ entity: 'Company', entityId: into._id, field: '_merged', before: { id: String(from._id), name: from.name }, by });
  await Company.deleteOne({ _id: from._id });
  await refreshContactStats(into._id);
  const fresh = (await Company.findById(into._id).lean())!;
  await Company.updateOne({ _id: into._id }, { $set: { completeness: completenessOf(fresh) } });
  return String(into._id);
}

/** A person says the flagged pair are different companies: clear the flag and never raise it again. */
export async function markNotDuplicate(companyId: string, by: string) {
  const c = await Company.findById(companyId).lean();
  if (!c) throw notFound('Company not found');
  if (!c.duplicateOf) throw conflict('This company isn’t flagged as a duplicate');
  const other = c.duplicateOf;
  await Company.updateOne({ _id: c._id }, { $unset: { duplicateOf: 1, duplicateReason: 1 }, $addToSet: { notDuplicateOf: other } });
  await Company.updateOne({ _id: other }, { $addToSet: { notDuplicateOf: c._id } });
  await History.create({ entity: 'Company', entityId: c._id, field: '_notDuplicate', before: String(other), by });
}

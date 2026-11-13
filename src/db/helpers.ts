import type { Model, Types } from 'mongoose';
import type { StepKey, StepStatus } from '../contract.js';
import { Company, type CompanyDoc, Contact, History } from './models.js';

type Id = Types.ObjectId | string;
const get = (obj: any, path: string) => path.split('.').reduce((o, k) => o?.[k], obj);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Every step ends with this, success or not (PTC §2.1): the company keeps moving and the UI can always say why.
 * Also refreshes the completeness score, since a step finishing is when it changes.
 */
export async function setStep(companyId: Id, step: StepKey, status: StepStatus, reason?: string) {
  const doc = await Company.findByIdAndUpdate(
    companyId,
    { $set: { [`stages.${step}`]: { status, reason, updatedAt: new Date() } } },
    { returnDocument: 'after', lean: true },
  );
  if (doc) await Company.updateOne({ _id: companyId }, { $set: { completeness: completenessOf(doc) } });
}

/**
 * Every edit a person makes goes through here (NFR-02): the old value goes to `history`,
 * and the field is added to `lockedFields` so workers never overwrite it later (FR-11).
 * `by` is a user email, or 'system' for automated changes (system changes don't lock fields).
 * `lock: false` records history without locking (e.g. a reviewer overriding a step status).
 */
export async function saveWithHistory(M: Model<any>, id: Id, changes: Record<string, unknown>, by: string, { lock = true } = {}) {
  const before = await M.findById(id).lean();
  if (!before) return null;
  const changed = Object.entries(changes).filter(([k, v]) => !same(get(before, k), v));
  if (!changed.length) return before;

  await History.insertMany(
    changed.map(([field, after]) => ({ entity: M.modelName, entityId: id, field, before: get(before, field), after, by })),
  );
  const update: Record<string, unknown> = { $set: Object.fromEntries(changed) };
  if (lock && by !== 'system' && 'lockedFields' in (before as object))
    update.$addToSet = { lockedFields: { $each: changed.map(([k]) => k) } };
  return M.findByIdAndUpdate(id, update, { returnDocument: 'after' }).lean();
}

/** Keeps the company's contact counters in sync after contacts change (used for list filters). */
export async function refreshContactStats(companyId: Id) {
  const contacts = await Contact.find({ company: companyId }).lean();
  const statuses = [...new Set(contacts.flatMap((c) => c.emails.map((e) => e.verification?.status ?? 'not_checked')))];
  await Company.updateOne({ _id: companyId }, { $set: { contactsCount: contacts.length, emailStatuses: statuses } });
}

/** 0–100: share of the things we want to know about a company that we actually have. */
export function completenessOf(c: Pick<CompanyDoc, 'editions' | 'website' | 'socials' | 'contactsCount' | 'emailStatuses' | 'ai'>) {
  const e = c.editions ?? [];
  const checks = [
    e.length > 0,
    !!c.website?.url,
    e.some((x) => x.description),
    e.some((x) => x.country),
    e.some((x) => x.category),
    !!(c.socials?.linkedin || c.socials?.facebook || c.socials?.instagram || c.socials?.x || c.socials?.youtube),
    (c.website?.facts?.length ?? 0) > 0,
    (c.contactsCount ?? 0) > 0,
    (c.emailStatuses?.length ?? 0) > 0,
    !!c.ai?.summary,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

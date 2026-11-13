import type { Model, Types } from 'mongoose';
import type { StepKey, StepStatus } from '../contract.js';
import { Company, Contact, History, STEPS } from './models.js';

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
 * `lock: false` records history without locking. Returns the updated doc and which fields really changed.
 */
export async function saveWithHistory(M: Model<any>, id: Id, changes: Record<string, unknown>, by: string, { lock = true } = {}) {
  const before = await M.findById(id).lean();
  if (!before) return { doc: null, changed: [] as string[] };
  const changed = Object.entries(changes).filter(([k, v]) => !same(get(before, k), v));
  if (!changed.length) return { doc: before, changed: [] as string[] };

  await History.insertMany(
    changed.map(([field, after]) => ({ entity: M.modelName, entityId: id, field, before: get(before, field), after, by })),
  );
  const update: Record<string, unknown> = { $set: Object.fromEntries(changed) };
  if (lock && by !== 'system' && 'lockedFields' in (before as object))
    update.$addToSet = { lockedFields: { $each: changed.map(([k]) => k) } };
  const doc = await M.findByIdAndUpdate(id, update, { returnDocument: 'after' }).lean();
  return { doc, changed: changed.map(([k]) => k) };
}

/** Keeps the company's contact counters in sync after contacts change (used for list filters). */
export async function refreshContactStats(companyId: Id) {
  const contacts = await Contact.find({ company: companyId }).lean();
  const statuses = [...new Set(contacts.flatMap((c) => c.emails.map((e) => e.verification?.status ?? 'not_checked')))];
  await Company.updateOne({ _id: companyId }, { $set: { contactsCount: contacts.length, emailStatuses: statuses } });
}

// How much each step status counts towards completeness (same formula the frontend shows).
const SCORE: Record<StepStatus, number> = {
  completed: 1,
  approved: 1,
  partial: 0.5,
  not_started: 0,
  in_progress: 0,
  needs_review: 0,
  pending_access: 0,
  restricted: 0,
  failed: 0,
};

/** 0–100: completed/approved steps count 1, partial ½, everything else 0, averaged over all 8 steps. */
export function completenessOf(c: { stages?: unknown }) {
  const stages = (c.stages ?? {}) as Record<string, { status?: StepStatus } | undefined>;
  const total = STEPS.reduce((sum, k) => sum + SCORE[stages[k]?.status ?? 'not_started'], 0);
  return Math.round((100 * total) / STEPS.length);
}

/**
 * AI review (BE-4.4), same rules as the frontend's mock backend:
 *  - regenerate → 202. Without an AI key nothing is generated: the draft stays "pending" with the reason (FR-31).
 *  - save       → the edited fields become a new version (by the reviewer); status "draft".
 *  - approve    → copies the latest version into `approved`; only allowed when there is a draft (else 409).
 *  - reject     → needs a reason; status "rejected".
 * The approved copy only ever changes by approving again (FR-30). Every action goes to the company timeline.
 */
import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { setStep } from '../db/helpers.js';
import { toCompanyAi, toContactAi } from '../db/mappers.js';
import { Company, Contact, History } from '../db/models.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { enqueue } from '../pipeline/queue.js';
import { AI_REASON, llmEnabled } from '../providers/llm.js';

export const companyAiRoutes = Router(); // mounted at /companies
export const contactAiRoutes = Router(); // mounted at /contacts

const COMPANY_KEYS = ['summary', 'signal', 'signalUrl', 'hypothesis', 'hyperPersonalization'];
const CONTACT_KEYS = ['subject', 'draft', 'linkedinDraft'];

const patchSchema = z.object({
  action: z.enum(['save', 'approve', 'reject'], { error: '"action" must be save, approve or reject' }),
  fields: z.record(z.string(), z.string()).optional(),
  reason: z.string().optional(),
});

type AiDoc = { status?: string; versions?: { fields?: unknown }[] } & Record<string, unknown>;

/** Work out the update for one action. Throws the same errors as the frontend's mock. */
function plan(ai: AiDoc | undefined, keys: string[], input: z.infer<typeof patchSchema>, by: string) {
  const at = new Date();
  const current = Object.fromEntries(keys.map((k) => [k, typeof ai?.[k] === 'string' ? (ai[k] as string) : '']));
  switch (input.action) {
    case 'save': {
      const fields = input.fields ?? {};
      if (!Object.keys(fields).length) throw badRequest('"fields" is required to save');
      const unknown = Object.keys(fields).filter((k) => !keys.includes(k));
      if (unknown.length) throw badRequest(`"${unknown[0]}" is not an editable field`);
      const merged = { ...current, ...fields };
      return {
        $set: { ...Object.fromEntries(Object.entries(merged).map(([k, v]) => [`ai.${k}`, v])), 'ai.status': 'draft' },
        $unset: { 'ai.reason': 1 },
        $push: { 'ai.versions': { $each: [{ fields: merged, by, at }], $position: 0 } },
      };
    }
    case 'approve': {
      if (!ai?.status || ai.status === 'pending' || ai.status === 'insufficient_evidence') {
        throw conflict('There is no draft to approve. Add evidence or regenerate first.');
      }
      const latest = (ai.versions?.[0]?.fields as Record<string, string> | undefined) ?? current;
      const update: Record<string, unknown> = {
        $set: { 'ai.approved': { fields: latest, by, at }, 'ai.status': 'approved' },
        $unset: { 'ai.reason': 1 },
      };
      // No version yet (e.g. typed in before any AI run): record what was approved.
      if (!ai.versions?.length) update.$push = { 'ai.versions': { $each: [{ fields: latest, by, at }], $position: 0 } };
      return update;
    }
    case 'reject': {
      const reason = input.reason?.trim();
      if (!reason) throw badRequest('"reason" is required');
      return { $set: { 'ai.status': 'rejected', 'ai.reason': reason } };
    }
  }
}

const log = (companyId: Types.ObjectId, field: string, after: unknown, by: string) =>
  History.create({ entity: 'Company', entityId: companyId, field, before: null, after, by });

companyAiRoutes.post('/:id/ai/regenerate', async (req, res) => {
  const company = await Company.findById(req.params.id, { _id: 1 }).lean();
  if (!company) throw notFound('Company not found');
  if (!llmEnabled()) {
    await Company.updateOne({ _id: company._id }, { $set: { 'ai.status': 'pending', 'ai.reason': AI_REASON.noModel } });
  } else {
    await Company.updateOne({ _id: company._id }, { $set: { 'ai.status': 'pending', 'ai.reason': AI_REASON.generating } });
    await enqueue('personalization', { companyId: String(company._id), force: true });
  }
  res.status(202).json({ queued: true });
});

companyAiRoutes.patch('/:id/ai', async (req, res) => {
  const input = patchSchema.parse(req.body);
  const company = await Company.findById(req.params.id, { ai: 1 }).lean();
  if (!company) throw notFound('Company not found');
  await Company.updateOne({ _id: company._id }, plan(company.ai as AiDoc, COMPANY_KEYS, input, req.user!.email));
  const after = (await Company.findById(company._id, { ai: 1 }).lean())!;
  // The company's personalization step mirrors the review: approved, or waiting for a person.
  await setStep(
    company._id,
    'personalization',
    after.ai?.status === 'approved' ? 'approved' : 'needs_review',
    after.ai?.reason ?? undefined,
  );
  await log(company._id, `ai.${input.action}`, after.ai?.status, req.user!.email);
  res.json(toCompanyAi(after.ai));
});

contactAiRoutes.post('/:id/ai/regenerate', async (req, res) => {
  const contact = await Contact.findById(req.params.id, { company: 1 }).lean();
  if (!contact) throw notFound('Contact not found');
  if (!llmEnabled()) {
    await Contact.updateOne({ _id: contact._id }, { $set: { 'ai.status': 'pending', 'ai.reason': AI_REASON.noModel } });
  } else {
    await Contact.updateOne({ _id: contact._id }, { $set: { 'ai.status': 'pending', 'ai.reason': AI_REASON.generating } });
    await enqueue('personalization', { companyId: String(contact.company), contactId: String(contact._id), force: true });
  }
  res.status(202).json({ queued: true });
});

contactAiRoutes.patch('/:id/ai', async (req, res) => {
  const input = patchSchema.parse(req.body);
  const contact = await Contact.findById(req.params.id, { ai: 1, company: 1 }).lean();
  if (!contact) throw notFound('Contact not found');
  await Contact.updateOne({ _id: contact._id }, plan(contact.ai as AiDoc, CONTACT_KEYS, input, req.user!.email));
  const after = (await Contact.findById(contact._id, { ai: 1 }).lean())!;
  await log(contact.company, `contact:${contact._id}:ai.${input.action}`, after.ai?.status, req.user!.email);
  res.json(toContactAi(after.ai));
});

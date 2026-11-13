/**
 * Contacts (BE-3.2): decision-makers a reviewer found in Sales Navigator, entered by hand or pasted as CSV.
 * One company → many contacts. The same person (same LinkedIn link, or same name at the same company) is never stored twice.
 */
import { parse } from 'csv-parse/sync';
import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import type { ContactInput } from '../contract.js';
import { refreshContactStats, saveWithHistory } from '../db/helpers.js';
import { toContact } from '../db/mappers.js';
import { CONFIDENCE, Company, Contact, History } from '../db/models.js';
import { requireRole } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { cleanText, normalizeUrl } from '../lib/normalize.js';
import { suppressedOf } from '../lib/suppression.js';
import { queueIfReady } from '../pipeline/queue.js';

export const companyContactsRoutes = Router(); // mounted at /companies
export const contactsRoutes = Router(); // mounted at /contacts

const text = (max: number) => z.string().trim().min(1).max(max);
const emailInput = z.object({
  address: z.email().transform((e) => e.toLowerCase()),
  type: z.enum(['business', 'generic']).default('business'),
  provider: text(50).optional(),
});
const contactSchema = z.object({
  firstName: text(100),
  lastName: text(100),
  title: text(200).optional(),
  seniority: text(100).optional(),
  profileUrl: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .optional(),
  geography: text(200).optional(),
  matchConfidence: z.enum(CONFIDENCE).optional(),
  source: text(50),
  emails: z.array(emailInput).max(10).default([]),
});
type Input = z.infer<typeof contactSchema> & ContactInput;

/** linkedin.com/in/Jane-Doe/?trk=x → https://www.linkedin.com/in/jane-doe, so the same profile always matches. */
export function normalizeProfileUrl(raw?: string): string | undefined {
  const href = normalizeUrl(raw);
  if (!href) return undefined;
  const u = new URL(href);
  u.search = '';
  u.hash = '';
  if (/(^|\.)linkedin\.com$/i.test(u.hostname)) {
    u.hostname = 'www.linkedin.com';
    u.pathname = u.pathname.toLowerCase();
  }
  return u.href.replace(/\/$/, '');
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactCi = (s: string) => new RegExp(`^${escapeRegex(s)}$`, 'i');

function findSamePerson(companyId: Types.ObjectId, input: Pick<Input, 'firstName' | 'lastName' | 'profileUrl'>) {
  const or: Record<string, unknown>[] = [{ firstName: exactCi(input.firstName), lastName: exactCi(input.lastName) }];
  if (input.profileUrl) or.push({ profileUrl: input.profileUrl });
  return Contact.findOne({ company: companyId, $or: or }).lean();
}

/** Opted-out emails are refused outright (PTC §8.2). */
async function refuseSuppressed(emails: { address: string }[]) {
  const blocked = await suppressedOf(emails.map((e) => e.address));
  if (blocked.size) throw badRequest(`These emails have opted out and can’t be stored: ${[...blocked].join(', ')}`);
}

const newEmails = (existing: readonly { address: string }[], incoming: Input['emails']) => {
  const known = new Set(existing.map((e) => e.address));
  return incoming
    .filter((e) => !known.has(e.address))
    .map((e) => ({ ...e, provider: e.provider ?? 'manual', capturedAt: new Date(), verification: { status: 'not_checked' } }));
};

/** After contacts change: refresh the counters, and look up emails for anyone still missing one. */
async function afterContactsChanged(companyId: Types.ObjectId) {
  await refreshContactStats(companyId);
  const missing = await Contact.exists({ company: companyId, emails: { $not: { $elemMatch: { type: { $ne: 'generic' } } } } });
  if (missing) await queueIfReady('emails', { companyId: String(companyId) });
}

async function loadCompany(id: string) {
  const company = await Company.findById(id, { _id: 1 }).lean();
  if (!company) throw notFound('Company not found');
  return company;
}

companyContactsRoutes.post('/:id/contacts', async (req, res) => {
  const company = await loadCompany(String(req.params.id));
  const input = contactSchema.parse(req.body) as Input;
  input.profileUrl = normalizeProfileUrl(input.profileUrl);
  await refuseSuppressed(input.emails);
  const same = await findSamePerson(company._id, input);
  if (same) throw conflict('This person is already a contact of this company', { contactId: String(same._id) });

  const contact = await Contact.create({ ...input, company: company._id, emails: newEmails([], input.emails) });
  await History.create({
    entity: 'Contact',
    entityId: contact._id,
    field: '_created',
    after: { source: input.source },
    by: req.user!.email,
  });
  await afterContactsChanged(company._id);
  res.status(201).json(toContact(contact.toObject()));
});

const MAX_ROWS = 1000;

/** Paste a CSV (first_name,last_name,title,seniority,profile_url,geography,email). Bad rows are reported, good rows still go in. */
companyContactsRoutes.post('/:id/contacts/import', async (req, res) => {
  const company = await loadCompany(String(req.params.id));
  const { csv } = z.object({ csv: z.string().min(1).max(1_000_000) }).parse(req.body);
  let rows: Record<string, string>[];
  try {
    rows = parse(csv, {
      columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, '_')),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    });
  } catch (e) {
    throw badRequest(`Couldn’t read the CSV: ${(e as Error).message}`);
  }
  if (!rows.length) throw badRequest('The CSV has no rows');
  if (rows.length > MAX_ROWS) throw badRequest(`At most ${MAX_ROWS} rows per import`);
  if (!('first_name' in rows[0] && 'last_name' in rows[0])) throw badRequest('The CSV needs first_name and last_name columns');

  let created = 0;
  let updated = 0;
  const errors: { row: number; message: string }[] = [];
  for (const [i, r] of rows.entries()) {
    const row = i + 2; // header is row 1
    const parsed = contactSchema.safeParse({
      firstName: cleanText(r.first_name),
      lastName: cleanText(r.last_name),
      title: cleanText(r.title),
      seniority: cleanText(r.seniority),
      profileUrl: cleanText(r.profile_url),
      geography: cleanText(r.geography),
      source: 'csv_import',
      emails: cleanText(r.email) ? [{ address: cleanText(r.email) }] : [],
    });
    if (!parsed.success) {
      errors.push({ row, message: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
      continue;
    }
    const input = parsed.data as Input;
    input.profileUrl = normalizeProfileUrl(input.profileUrl);
    const blocked = await suppressedOf(input.emails.map((e) => e.address));
    if (blocked.size) {
      errors.push({ row, message: `Email has opted out: ${[...blocked].join(', ')}` });
      continue;
    }
    const same = await findSamePerson(company._id, input);
    if (!same) {
      const c = await Contact.create({ ...input, company: company._id, emails: newEmails([], input.emails) });
      await History.create({ entity: 'Contact', entityId: c._id, field: '_created', after: { source: 'csv_import' }, by: req.user!.email });
      created++;
      continue;
    }
    // Known person: fill blanks and add new emails, never overwrite what's there.
    const fill: Record<string, unknown> = {};
    for (const k of ['title', 'seniority', 'profileUrl', 'geography'] as const) if (!same[k] && input[k]) fill[k] = input[k];
    const add = newEmails(same.emails, input.emails);
    if (add.length) fill.emails = [...same.emails, ...add];
    if (Object.keys(fill).length) {
      await saveWithHistory(Contact, same._id, fill, req.user!.email);
      updated++;
    }
  }
  await afterContactsChanged(company._id);
  res.json({ created, updated, errors });
});

contactsRoutes.patch('/:id', async (req, res) => {
  const contact = await Contact.findById(req.params.id).lean();
  if (!contact) throw notFound('Contact not found');
  const input = contactSchema.partial().strict().parse(req.body) as Partial<Input>;
  if ('profileUrl' in input) input.profileUrl = normalizeProfileUrl(input.profileUrl);
  const changes: Record<string, unknown> = { ...input };
  if (input.emails) {
    // The list is replaced, but addresses we already had keep their capture date and check result.
    await refuseSuppressed(input.emails);
    const kept = contact.emails.filter((e) => input.emails!.some((n) => n.address === e.address));
    changes.emails = [...kept, ...newEmails(kept, input.emails)];
  }
  await saveWithHistory(Contact, contact._id, changes, req.user!.email);
  await afterContactsChanged(contact.company);
  res.json(toContact((await Contact.findById(contact._id).lean())!));
});

/** Admin only. History keeps that a contact was deleted, not who it was. */
contactsRoutes.delete('/:id', requireRole('admin'), async (req, res) => {
  const contact = await Contact.findById(req.params.id, { company: 1 }).lean();
  if (!contact) throw notFound('Contact not found');
  await Contact.deleteOne({ _id: contact._id });
  await History.create({ entity: 'Company', entityId: contact.company, field: '_contactDeleted', by: req.user!.email });
  await refreshContactStats(contact.company);
  res.sendStatus(204);
});

/**
 * Contacts (BE-3.2): decision-makers a reviewer found in Sales Navigator, entered by hand or pasted as CSV.
 * One company → many contacts. The same person (same LinkedIn link, or same name at the same company) is never stored twice:
 * saving them again updates the existing contact (200) instead of creating a copy (201).
 *
 * The company timeline gets one entry per contact change, field `contact:<id>` (same format as the frontend):
 *   added: null → "First Last" · updated: "updated" → "First Last" · deleted: "First Last" → null
 * Field-by-field contact edits are also kept in history (entity Contact) for the audit trail.
 */
import { parse } from 'csv-parse/sync';
import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { refreshContactStats, saveWithHistory } from '../db/helpers.js';
import { toContact } from '../db/mappers.js';
import { CONFIDENCE, Company, Contact, History } from '../db/models.js';
import { requireRole } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { cleanText, normalizeUrl } from '../lib/normalize.js';
import { suppressedOf } from '../lib/suppression.js';
import { queueIfReady } from '../pipeline/queue.js';

export const companyContactsRoutes = Router(); // mounted at /companies
export const contactsRoutes = Router(); // mounted at /contacts

const text = (max: number) => z.string().trim().min(1).max(max);
/** Optional text: "" or null means "no value" (and clears it on an edit). */
const optional = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === '' ? null : v), t.nullable().optional());
const emailInput = z.object({
  address: z.email({ error: 'Not a valid email address' }).transform((e) => e.toLowerCase()),
  type: z.enum(['business', 'generic']).default('business'),
  provider: text(50).optional(),
});
const contactSchema = z.object({
  firstName: text(100),
  lastName: text(100),
  title: optional(text(200)),
  seniority: optional(text(100)),
  profileUrl: optional(z.url({ protocol: /^https?$/, error: 'Must start with http:// or https://' }).max(500)),
  geography: optional(text(200)),
  matchConfidence: z.enum(CONFIDENCE).optional(),
  source: text(50),
  emails: z.array(emailInput).max(10).optional(),
});
type Input = z.infer<typeof contactSchema>;
type EmailIn = NonNullable<Input['emails']>[number];

/** linkedin.com/in/Jane-Doe/?trk=x → https://www.linkedin.com/in/jane-doe, so the same profile always matches. */
export function normalizeProfileUrl(raw?: string | null): string | undefined {
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
const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`;

function findSamePerson(companyId: Types.ObjectId, input: { firstName: string; lastName: string; profileUrl?: string | null }) {
  const or: Record<string, unknown>[] = [{ firstName: exactCi(input.firstName), lastName: exactCi(input.lastName) }];
  if (input.profileUrl) or.push({ profileUrl: input.profileUrl });
  return Contact.findOne({ company: companyId, $or: or }).lean();
}

/** Opted-out emails are refused outright (PTC §8.2). */
async function refuseSuppressed(emails: { address: string }[] = []) {
  const blocked = await suppressedOf(emails.map((e) => e.address));
  if (blocked.size)
    throw badRequest(`${[...blocked].join(', ')} ${blocked.size > 1 ? 'are' : 'is'} on the opt-out list and can’t be saved`);
}

const newEmails = (existing: readonly { address: string }[], incoming: EmailIn[] = [], provider = 'manual') => {
  const known = new Set(existing.map((e) => e.address));
  return incoming
    .filter((e) => !known.has(e.address))
    .map((e) => ({ ...e, provider: e.provider ?? provider, capturedAt: new Date(), verification: { status: 'not_checked' } }));
};

/** The company-timeline entry for a contact change. */
const logContact = (company: Types.ObjectId, contactId: Types.ObjectId, before: unknown, after: unknown, by: string) =>
  History.create({ entity: 'Company', entityId: company, field: `contact:${contactId}`, before, after, by });

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

/** Fields of the input that were actually given. `null` means "clear it". */
function givenFields(input: Partial<Input>) {
  const out: Record<string, unknown> = {};
  for (const k of ['firstName', 'lastName', 'title', 'seniority', 'profileUrl', 'geography', 'matchConfidence', 'source'] as const) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  return out;
}

/** Create the contact, or update the same person if they're already there. Returns whether it was new. */
async function upsertContact(companyId: Types.ObjectId, input: Input, by: string, mode: 'form' | 'import') {
  input.profileUrl = normalizeProfileUrl(input.profileUrl) ?? (input.profileUrl === null ? null : undefined);
  const provider = mode === 'import' ? 'csv_import' : 'manual';
  const same = await findSamePerson(companyId, input);
  if (!same) {
    const fields = Object.fromEntries(Object.entries(givenFields(input)).filter(([, v]) => v !== null));
    const c = await Contact.create({ ...fields, company: companyId, emails: newEmails([], input.emails, provider) });
    await logContact(companyId, c._id, null, fullName(c), by);
    return { contact: c.toObject(), created: true, changed: true };
  }
  // Known person. A form overwrites what was typed in; an import only fills blanks (it never clobbers a reviewer's edits).
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(givenFields(input))) {
    if (mode === 'form' || (same as any)[k] == null) changes[k] = v;
  }
  const add = newEmails(same.emails, input.emails, provider);
  if (add.length) changes.emails = [...same.emails, ...add];
  const { doc, changed } = await saveWithHistory(Contact, same._id, changes, by);
  if (changed.length) await logContact(companyId, same._id, 'updated', fullName(doc ?? same), by);
  return { contact: same, created: false, changed: changed.length > 0 };
}

companyContactsRoutes.post('/:id/contacts', async (req, res) => {
  const company = await loadCompany(String(req.params.id));
  const input = contactSchema.parse(req.body);
  await refuseSuppressed(input.emails);
  const { contact, created } = await upsertContact(company._id, input, req.user!.email, 'form');
  await afterContactsChanged(company._id);
  res.status(created ? 201 : 200).json(toContact((await Contact.findById(contact._id).lean())!));
});

const MAX_ROWS = 1000;
const CSV_COLUMNS = ['first_name', 'last_name', 'title', 'seniority', 'profile_url', 'geography', 'email'];

/** Paste a CSV (first_name,last_name,title,seniority,profile_url,geography,email). Bad rows are reported, good rows still go in. */
companyContactsRoutes.post('/:id/contacts/import', async (req, res) => {
  const company = await loadCompany(String(req.params.id));
  const { csv } = z.object({ csv: z.string().min(1, '"csv" is required').max(1_000_000) }).parse(req.body);
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
  const header = Object.keys(rows[0]);
  const missing = ['first_name', 'last_name'].filter((c) => !header.includes(c));
  if (missing.length) throw badRequest(`The first row must contain these columns: ${missing.join(', ')}`);
  const unknown = header.filter((h) => !CSV_COLUMNS.includes(h));
  if (unknown.length) throw badRequest(`Unknown columns: ${unknown.join(', ')}`);

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
      errors.push({ row, message: parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ') });
      continue;
    }
    const blocked = await suppressedOf((parsed.data.emails ?? []).map((e) => e.address));
    if (blocked.size) {
      errors.push({ row, message: `${[...blocked].join(', ')} is on the opt-out list and can’t be saved` });
      continue;
    }
    const result = await upsertContact(company._id, parsed.data, req.user!.email, 'import');
    if (result.created) created++;
    else if (result.changed) updated++;
  }
  await afterContactsChanged(company._id);
  res.json({ created, updated, errors });
});

contactsRoutes.patch('/:id', async (req, res) => {
  const contact = await Contact.findById(req.params.id).lean();
  if (!contact) throw notFound('Contact not found');
  const input = contactSchema.partial().strict().parse(req.body);
  if (input.profileUrl) input.profileUrl = normalizeProfileUrl(input.profileUrl);
  const changes = givenFields(input);
  if (input.emails) {
    // The list is replaced, but addresses we already had keep their capture date and check result.
    await refuseSuppressed(input.emails);
    const kept = contact.emails.filter((e) => input.emails!.some((n) => n.address === e.address));
    changes.emails = [...kept, ...newEmails(kept, input.emails)];
  }
  const { doc, changed } = await saveWithHistory(Contact, contact._id, changes, req.user!.email);
  if (changed.length) await logContact(contact.company, contact._id, 'updated', fullName(doc ?? contact), req.user!.email);
  await afterContactsChanged(contact.company);
  res.json(toContact((await Contact.findById(contact._id).lean())!));
});

/** Admin only. */
contactsRoutes.delete('/:id', requireRole('admin'), async (req, res) => {
  const contact = await Contact.findById(req.params.id, { company: 1, firstName: 1, lastName: 1 }).lean();
  if (!contact) throw notFound('Contact not found');
  await Contact.deleteOne({ _id: contact._id });
  await logContact(contact.company, contact._id, fullName(contact), null, req.user!.email);
  await refreshContactStats(contact.company);
  res.sendStatus(204);
});

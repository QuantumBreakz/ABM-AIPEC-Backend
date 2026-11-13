/**
 * CSV exports (BE-4.5, PTC §6.3). Columns and rules match the frontend's mock backend.
 *
 *  companies.csv  one row per company
 *  contacts.csv   one row per contact email (a contact without email still gets one row)
 *  outreach.csv   one row per company–contact pair; companies with no contact keep one row
 *
 * `version=initial` is the file made before the bulk email check: every email reads "not_checked" with no date.
 * `version=final` carries the real check results and dates. Both are logged (who, when, filters, rows),
 * which also proves the order initial → verification → final.
 * Filters are exactly the company list's. AI columns prefer the approved copy. Opted-out emails are never exported.
 * Rows stream out in batches, so memory stays flat on big exports.
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Company as CompanyT, ExportKind, ExportLogEntry } from '../contract.js';
import { toCompany } from '../db/mappers.js';
import { Company, Contact, EXPORT_KINDS, ExportLog, Suppression } from '../db/models.js';
import { BOM, type Cell, csvLine } from '../lib/csv.js';
import { badRequest } from '../lib/errors.js';
import { normalizeName } from '../lib/normalize.js';
import { companyFiltersSchema, companyQuery, SORT } from './companies.js';
import { paging } from './paging.js';

export const exportsRoutes = Router();

type Version = 'initial' | 'final';

const COMPANY_COLUMNS = [
  'Company ID',
  'Company',
  'Original Names',
  'Editions',
  'ADIPEC Profile URL',
  'Stand',
  'Category',
  'Country',
  'ADIPEC Description',
  'Domain',
  'Website',
  'Company Summary',
  'Services',
  'Markets',
  'LinkedIn',
  'Facebook',
  'Instagram',
  'X',
  'YouTube',
  'Other Social Links',
  'Profile Status',
  'Website Status',
  'Social Status',
  'Account Status',
  'People Status',
  'Emails Status',
  'Verification Status',
  'Personalization Status',
  'Duplicate Of',
  'Completeness',
  'Hyper-Personalization',
  'Evidence URLs',
  'Last Updated',
];
const CONTACT_COLUMNS = [
  'Contact ID',
  'Company ID',
  'Company',
  'First Name',
  'Last Name',
  'Title',
  'Seniority',
  'Profile URL',
  'Geography',
  'Match Confidence',
  'Source',
  'Email',
  'Email Type',
  'Email Provider',
  'Email Captured',
  'Verification Status',
  'Verification Date',
  'Verification Source',
];
const OUTREACH_COLUMNS = [
  'Company ID',
  'Company',
  'Domain',
  'Website',
  'ADIPEC Profile URL',
  'LinkedIn Company',
  'Contact ID',
  'First Name',
  'Last Name',
  'Title',
  'Profile URL',
  'Email',
  'Email Verification Status',
  'Verification Date',
  'Contact Source',
  'Hyper-Personalization',
  'Subject Line',
  'Email Draft',
  'LinkedIn Draft',
  'Evidence URLs',
  'AI Status',
];
// Columns the PTC requires (§5.1, §6.1–6.3) beyond the frontend mock's set. Added at the end so the mock's
// columns keep their positions.
const COMPANY_EXTRA = [
  'Normalized Name',
  'Directory Capture Date',
  'Reviewed Pages',
  'Unread Pages',
  'Sales Navigator Account',
  'Account Match Confidence',
  'Leadership Coverage',
  'Contacts Count',
  'AI Research Summary',
  'Observed Signal',
  'Signal URL',
  'Opportunity Hypothesis',
  'AI Status',
  'AI Review Notes',
  'AI Approved At',
];
const CONTACT_EXTRA = ['Leadership Coverage', 'Contact AI Status'];
const OUTREACH_EXTRA = [
  'Research Summary',
  'Observed Signal',
  'Signal URL',
  'Opportunity Hypothesis',
  'Other Social Links',
  'Sales Navigator Account',
  'Leadership Coverage',
  'Seniority',
  'Email Type',
  'Email Source',
  'Email Captured',
  'Verification Source',
  'AI Review Notes',
  'AI Approved At',
];
const HEADERS: Record<ExportKind, string[]> = {
  companies: [...COMPANY_COLUMNS, ...COMPANY_EXTRA],
  contacts: [...CONTACT_COLUMNS, ...CONTACT_EXTRA],
  outreach: [...OUTREACH_COLUMNS, ...OUTREACH_EXTRA],
};

const join = (xs?: (string | number)[]) => (xs ?? []).join(' | ');
/** The approved copy wins over the latest draft. */
const approvedOr = (ai: { approved?: { fields: Record<string, string> } } & Record<string, unknown>, key: string) =>
  ai.approved?.fields[key] ?? (typeof ai[key] === 'string' ? (ai[key] as string) : '');

function* rowsFor(kind: ExportKind, c: CompanyT, version: Version, blocked: Set<string>): Generator<Cell[]> {
  const e0 = c.editions[0];
  const ok = (address: string) => !blocked.has(address) && !blocked.has(address.split('@')[1]);
  const status = (real: string) => (version === 'initial' ? 'not_checked' : real);
  const hp = approvedOr(c.ai as never, 'hyperPersonalization');
  const companyAi = ['summary', 'signal', 'signalUrl', 'hypothesis'].map((k) => approvedOr(c.ai as never, k));
  const otherSocials = join(
    [c.socials.facebook, c.socials.instagram, c.socials.x, c.socials.youtube, ...c.socials.other].filter((x): x is string => !!x),
  );

  if (kind === 'companies') {
    const s = c.stages;
    yield [
      c.id,
      c.name,
      join(c.originalNames),
      join(c.editions.map((x) => x.edition)),
      e0?.profileUrl,
      c.stand,
      c.category,
      c.country,
      e0?.description,
      c.domain,
      c.website.url,
      c.website.summary,
      join(c.website.services),
      join(c.website.markets),
      c.socials.linkedin,
      c.socials.facebook,
      c.socials.instagram,
      c.socials.x,
      c.socials.youtube,
      join(c.socials.other),
      s.profile.status,
      s.website.status,
      s.social.status,
      s.account.status,
      s.people.status,
      s.emails.status,
      s.verification.status,
      s.personalization.status,
      c.duplicateOf,
      c.completeness,
      hp,
      join(c.ai.evidenceUrls),
      c.updatedAt,
      // extras
      normalizeName(c.name),
      e0?.capturedAt,
      join(c.website.pagesReviewed.map((p) => p.url)),
      join(c.website.skipped.map((p) => `${p.url} (${p.reason})`)),
      c.salesNav.accountUrl,
      c.salesNav.matchConfidence,
      c.leadershipCoverage,
      c.contactsCount,
      ...companyAi,
      c.ai.status,
      c.ai.reason,
      c.ai.approved?.at,
    ];
    return;
  }

  if (kind === 'contacts') {
    for (const p of c.contacts) {
      const emails = p.emails.filter((e) => ok(e.address));
      for (const e of emails.length ? emails : [undefined]) {
        yield [
          p.id,
          c.id,
          c.name,
          p.firstName,
          p.lastName,
          p.title,
          p.seniority,
          p.profileUrl,
          p.geography,
          p.matchConfidence,
          p.source,
          e?.address,
          e?.type,
          e?.provider,
          e?.capturedAt,
          e ? status(e.verification.status) : undefined,
          e && version === 'final' ? e.verification.checkedAt : undefined,
          e && version === 'final' ? e.verification.source : undefined,
          // extras
          c.leadershipCoverage,
          p.ai.status,
        ];
      }
    }
    return;
  }

  // outreach
  const head: Cell[] = [c.id, c.name, c.domain, c.website.url, e0?.profileUrl, c.socials.linkedin];
  if (!c.contacts.length) {
    yield [
      ...head,
      ...Array(9).fill(undefined),
      hp,
      undefined,
      undefined,
      undefined,
      join(c.ai.evidenceUrls),
      c.ai.status,
      // extras
      ...companyAi,
      otherSocials,
      c.salesNav.accountUrl,
      c.leadershipCoverage,
      ...Array(5).fill(undefined), // seniority, email type, email source, captured, verification source
      c.ai.reason,
      c.ai.approved?.at,
    ];
    return;
  }
  for (const p of c.contacts) {
    const e = p.emails.find((x) => ok(x.address));
    const ai = (key: string) => approvedOr(p.ai as never, key);
    yield [
      ...head,
      p.id,
      p.firstName,
      p.lastName,
      p.title,
      p.profileUrl,
      e?.address,
      e ? status(e.verification.status) : undefined,
      e && version === 'final' ? e.verification.checkedAt : undefined,
      p.source,
      hp,
      ai('subject'),
      ai('draft'),
      ai('linkedinDraft'),
      join([...c.ai.evidenceUrls, ...p.ai.evidenceUrls]),
      p.ai.status,
      // extras
      ...companyAi,
      otherSocials,
      c.salesNav.accountUrl,
      c.leadershipCoverage,
      p.seniority,
      e?.type,
      e?.provider,
      e?.capturedAt,
      e && version === 'final' ? e.verification.source : undefined,
      p.ai.reason,
      p.ai.approved?.at,
    ];
  }
}

const BATCH = 200;

/** Every matching company (with its contacts), in list order, a batch at a time. */
async function* companiesFor(query: Record<string, unknown>, sort: Record<string, 1 | -1>) {
  const cursor = Company.find(query).sort(sort).lean().cursor({ batchSize: BATCH });
  let batch: Awaited<ReturnType<typeof Company.findOne>>[] = [];
  const flush = async function* () {
    const docs = batch as any[];
    batch = [];
    const contacts = await Contact.find({ company: { $in: docs.map((d) => d._id) } })
      .sort({ lastName: 1, firstName: 1 })
      .lean();
    for (const d of docs)
      yield toCompany(
        d,
        contacts.filter((ct) => String(ct.company) === String(d._id)),
      );
  };
  for await (const doc of cursor) {
    batch.push(doc as never);
    if (batch.length >= BATCH) yield* flush();
  }
  if (batch.length) yield* flush();
}

const blockedSet = async () => new Set((await Suppression.find({}, { value: 1 }).lean()).map((s) => s.value));
const kindOf = (raw: string) => {
  if (!(EXPORT_KINDS as readonly string[]).includes(raw)) throw badRequest(`Export type must be one of: ${EXPORT_KINDS.join(', ')}`);
  return raw as ExportKind;
};
/** The filters as the user set them (not version/page), for the export log. */
const loggedFilters = (q: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(q).filter(([k]) => !['version', 'page', 'pageSize'].includes(k)));

async function countRows(kind: ExportKind, query: Record<string, unknown>, sort: Record<string, 1 | -1>) {
  const blocked = await blockedSet();
  let n = 0;
  for await (const c of companiesFor(query, sort)) for (const _ of rowsFor(kind, c, 'final', blocked)) n++;
  return n;
}

// Exports hold contact data: at most 20 downloads a minute per user.
const exportLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req) => req.user?.id ?? 'anon',
  handler: (_req, res) => {
    res.status(429).json({ error: { code: 'rate_limited', message: 'Too many exports in a minute. Wait a moment and try again.' } });
  },
});

// Registered before /:file so "log" isn't read as a file name.
exportsRoutes.get('/log', async (req, res) => {
  const { page, pageSize, skip } = paging(req.query);
  const [docs, total] = await Promise.all([
    ExportLog.find().sort({ at: -1 }).skip(skip).limit(pageSize).lean(),
    ExportLog.countDocuments(),
  ]);
  const items: ExportLogEntry[] = docs.map((d) => ({
    id: String(d._id),
    kind: d.kind as ExportKind,
    version: d.version as Version,
    filters: d.filters ?? {},
    rows: d.rows ?? 0,
    by: d.by ?? '',
    at: d.at.toISOString(),
  }));
  res.json({ items, page, pageSize, total });
});

exportsRoutes.get('/:kind/count', async (req, res) => {
  const kind = kindOf(String(req.params.kind));
  const filters = companyFiltersSchema.parse(req.query);
  res.json({ rows: await countRows(kind, companyQuery(filters), SORT[filters.sort]) });
});

exportsRoutes.get('/:file', exportLimit, async (req, res) => {
  const match = /^(.+)\.csv$/.exec(String(req.params.file));
  if (!match) throw badRequest('Download a file like /exports/outreach.csv');
  const kind = kindOf(match[1]);
  const { version } = z
    .object({ version: z.enum(['initial', 'final'], { error: '"version" must be initial or final' }).default('initial') })
    .parse(req.query);
  const filters = companyFiltersSchema.parse(req.query);
  const blocked = await blockedSet();

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${kind}-${version}.csv"`);
  res.write(BOM + csvLine(HEADERS[kind]));
  let rows = 0;
  for await (const c of companiesFor(companyQuery(filters), SORT[filters.sort])) {
    let chunk = '';
    for (const row of rowsFor(kind, c, version, blocked)) {
      chunk += csvLine(row);
      rows++;
    }
    if (chunk && !res.write(chunk)) await new Promise((r) => res.once('drain', r)); // respect back-pressure
  }
  res.end();
  await ExportLog.create({ kind, version, filters: loggedFilters(req.query as Record<string, unknown>), rows, by: req.user!.email });
});

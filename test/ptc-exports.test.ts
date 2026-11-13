/** PTC §5.1 / §6.1–6.3: every required export field is present, rows line up with headers, and the §6.3 filters work. */
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { Company, Contact, User } from '../src/db/models.js';
import { closeQueues, drainAll } from '../src/pipeline/queue.js';

let admin: ReturnType<typeof request.agent>;

/** Minimal CSV reader (quotes, commas, CRLF) for checking our own files. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && s[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return rows;
}
const download = async (path: string) => parseCsv((await admin.get(path).expect(200)).text);
const asRecords = (rows: string[][]) => rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]])));

beforeAll(async () => {
  await User.create({ email: 'admin@example.com', role: 'admin', passwordHash: await bcrypt.hash('password-123', 4) });
  admin = request.agent(app);
  await admin.post('/auth/login').send({ email: 'admin@example.com', password: 'password-123' }).expect(200);
  const approved = {
    fields: {
      summary: 'Approved summary',
      signal: 'Approved signal',
      signalUrl: 'https://kappa.example/news',
      hypothesis: 'They might benefit.',
      hyperPersonalization: 'Approved opener',
    },
    by: 'ali@example.com',
    at: new Date('2026-11-10T10:00:00Z'),
  };
  const [kappa] = await Company.create([
    {
      name: 'Kappa Energy LLC',
      normalizedName: 'kappa energy',
      domain: 'kappa.example',
      editions: [
        { edition: 2026, sourceId: '1', profileUrl: 'https://www.adipec.com/x?id=1', capturedAt: new Date('2026-11-01T00:00:00Z') },
      ],
      website: {
        url: 'https://kappa.example/',
        pagesReviewed: [
          { url: 'https://kappa.example/', fetchedAt: new Date() },
          { url: 'https://kappa.example/about', fetchedAt: new Date() },
        ],
        skipped: [{ url: 'https://kappa.example/news', reason: 'The website answered HTTP 500' }],
      },
      socials: { linkedin: 'https://www.linkedin.com/company/kappa', youtube: 'https://www.youtube.com/@kappa' },
      salesNav: { accountUrl: 'https://www.linkedin.com/sales/company/1', matchConfidence: 'high' },
      leadershipCoverage: 'confirmed_partial',
      completeness: 75,
      ai: { status: 'approved', summary: 'Newer draft', approved, versions: [approved] },
      contactsCount: 1,
    },
    {
      name: 'Lambda Pumps',
      normalizedName: 'lambda pumps',
      editions: [{ edition: 2026, sourceId: '2' }],
      completeness: 20,
      ai: { status: 'draft', reason: 'Too generic' },
    },
  ]);
  await Contact.create({
    company: kappa._id,
    firstName: 'Ana',
    lastName: 'Sample',
    seniority: 'C-level',
    source: 'manual',
    emails: [
      {
        address: 'ana@kappa.example',
        type: 'business',
        provider: 'contactout',
        verification: { status: 'verified', checkedAt: new Date(), source: 'millionverifier: ok' },
      },
    ],
    ai: { status: 'draft', subject: 'Question', draft: 'Body' },
  });
});
afterAll(async () => {
  await drainAll();
  await closeQueues();
});

describe('every row lines up with its header', () => {
  it.each(['companies', 'contacts', 'outreach'])('%s.csv (initial and final)', async (kind) => {
    for (const version of ['initial', 'final']) {
      const rows = await download(`/exports/${kind}.csv?version=${version}`);
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) expect(r).toHaveLength(rows[0].length);
    }
  });
});

describe('PTC-required fields', () => {
  it('companies.csv has identity, research, Sales Nav, coverage and AI fields (§6.1, §6.2)', async () => {
    const kappa = asRecords(await download('/exports/companies.csv')).find((r) => r.Company === 'Kappa Energy LLC')!;
    expect(kappa).toMatchObject({
      'Normalized Name': 'kappa energy',
      'Directory Capture Date': '2026-11-01T00:00:00.000Z',
      'Reviewed Pages': 'https://kappa.example/ | https://kappa.example/about',
      'Unread Pages': 'https://kappa.example/news (The website answered HTTP 500)',
      'Sales Navigator Account': 'https://www.linkedin.com/sales/company/1',
      'Account Match Confidence': 'high',
      'Leadership Coverage': 'confirmed_partial',
      'AI Research Summary': 'Approved summary', // the approved copy wins over the newer draft
      'Observed Signal': 'Approved signal',
      'Signal URL': 'https://kappa.example/news',
      'Opportunity Hypothesis': 'They might benefit.',
      'AI Status': 'approved',
      'AI Approved At': '2026-11-10T10:00:00.000Z',
    });
  });

  it('outreach.csv has the research summary, signal, hypothesis, all socials and the email source (§5.1, §6.3)', async () => {
    const final = asRecords(await download('/exports/outreach.csv?version=final'));
    const ana = final.find((r) => r['First Name'] === 'Ana')!;
    expect(ana).toMatchObject({
      'Research Summary': 'Approved summary',
      'Observed Signal': 'Approved signal',
      'Signal URL': 'https://kappa.example/news',
      'Opportunity Hypothesis': 'They might benefit.',
      'Other Social Links': 'https://www.youtube.com/@kappa',
      'Sales Navigator Account': 'https://www.linkedin.com/sales/company/1',
      'Leadership Coverage': 'confirmed_partial',
      Seniority: 'C-level',
      'Email Type': 'business',
      'Email Source': 'contactout',
      'Email Verification Status': 'verified',
      'Verification Source': 'millionverifier: ok',
      'Hyper-Personalization': 'Approved opener',
    });
    const initial = asRecords(await download('/exports/outreach.csv?version=initial')).find((r) => r['First Name'] === 'Ana')!;
    expect([initial['Email Verification Status'], initial['Verification Source']]).toEqual(['not_checked', '']);
    const lambda = final.find((r) => r.Company === 'Lambda Pumps')!; // company with no contact keeps one row
    expect([lambda['First Name'], lambda['AI Review Notes']]).toEqual(['', 'Too generic']);
  });
});

describe('§6.3 filters: research completeness and approval', () => {
  it('filters the list and the exports the same way', async () => {
    expect((await admin.get('/companies?minCompleteness=50')).body.items.map((c: { name: string }) => c.name)).toEqual([
      'Kappa Energy LLC',
    ]);
    expect((await admin.get('/companies?approved=true')).body.total).toBe(1);
    expect((await admin.get('/companies?approved=false')).body.items[0].name).toBe('Lambda Pumps');
    expect((await admin.get('/exports/companies/count?minCompleteness=50')).body).toEqual({ rows: 1 });
    expect((await admin.get('/companies?minCompleteness=101')).status).toBe(400);
  });
});
